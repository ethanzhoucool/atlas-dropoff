/* ============================================================
   local.ts — compute the same numbers a warehouse query would,
   in-process, from a stream of raw events.

   Some vendors can't answer "distinct users over this range,
   grouped by screen" in one call (Mixpanel's segmentation API
   returns per-day uniques, and summing days over-counts anyone
   who came back). Rather than ship a wrong number, those sources
   pull the raw event stream and aggregate it here.

   The payoff is that this also yields an EXACT sequential funnel
   (the same semantics as ClickHouse `windowFunnel`, which is what
   the PostHog source uses), instead of the pairwise estimate.
   ============================================================ */

import type { Counts, ScreenCount, SourceId, TransitionCount } from '../types.js';

/** One screen view, already normalized out of a vendor's export format. */
export interface RawEvent {
  /** Person key — the identified user id when the event carries one. */
  user: string;
  screen: string;
  prevScreen: string | null;
  /** Milliseconds since epoch. Millisecond precision matters: a fast
   * onboarding flow emits several screens inside one second, and second-
   * granularity timestamps would tie and make their order ambiguous. */
  timeMs: number;
  /**
   * Anonymous device/install id, when the event carries one alongside an
   * identified id. That pairing is what lets the accumulator stitch a user's
   * pre-login and post-login screens together itself, instead of trusting the
   * export to have resolved identity already — an unmerged login boundary
   * would split one person in two and understate conversion.
   */
  deviceId?: string;
  /** The identified user id, when present. */
  userId?: string;
}

/**
 * Per-user event cap. A runaway client (or a bot) must not be able to grow
 * one timeline without bound; 20k screen views is far beyond any real session
 * history in a 28-day window.
 */
const MAX_EVENTS_PER_USER = 20_000;

interface Timeline {
  /** Interned screen ids, in capture order. */
  screens: number[];
  /** Interned previous-screen ids (-1 for none), parallel to `screens`. */
  prev: number[];
  /** Milliseconds since epoch, parallel to `screens`. */
  times: number[];
  sorted: boolean;
  /** Events dropped by MAX_EVENTS_PER_USER. */
  dropped: number;
}

/**
 * Accumulates raw events, then answers the same three aggregate questions the
 * HogQL queries answer — plus an exact sequential funnel.
 */
export class EventAccumulator {
  private readonly ids = new Map<string, number>();
  private readonly names: string[] = [];
  private readonly users = new Map<string, Timeline>();
  /** Anonymous key → identified user id, learned from events carrying both. */
  private readonly aliases = new Map<string, string>();
  private merged = false;
  private total = 0;
  private droppedEvents = 0;

  get eventCount(): number {
    return this.total;
  }

  get userCount(): number {
    return this.users.size;
  }

  /** Events discarded by the per-user cap. */
  get droppedCount(): number {
    return this.droppedEvents;
  }

  private intern(screen: string): number {
    const existing = this.ids.get(screen);
    if (existing !== undefined) return existing;
    const id = this.names.length;
    this.ids.set(screen, id);
    this.names.push(screen);
    return id;
  }

  add(event: RawEvent): void {
    if (!event.user || !event.screen) return;
    // An event carrying both ids says "this device is this person". Record it
    // under every spelling the anonymous events might have used, so the
    // pre-login timeline can be folded in at finalize time.
    if (event.deviceId && event.userId && event.deviceId !== event.userId) {
      this.aliases.set(event.deviceId, event.userId);
      this.aliases.set(`$device:${event.deviceId}`, event.userId);
      this.merged = false;
    }
    let timeline = this.users.get(event.user);
    if (!timeline) {
      timeline = { screens: [], prev: [], times: [], sorted: true, dropped: 0 };
      this.users.set(event.user, timeline);
    }
    if (timeline.screens.length >= MAX_EVENTS_PER_USER) {
      timeline.dropped++;
      this.droppedEvents++;
      return;
    }
    const t = event.timeMs;
    const n = timeline.times.length;
    if (n > 0 && t < timeline.times[n - 1]) timeline.sorted = false;
    timeline.screens.push(this.intern(event.screen));
    timeline.prev.push(event.prevScreen ? this.intern(event.prevScreen) : -1);
    timeline.times.push(t);
    this.total++;
  }

  /**
   * Fold every anonymous timeline into the person it turned out to belong to,
   * then sort each timeline by time. Exports arrive in arbitrary order, and
   * both the transition attribution and the funnel depend on real chronology.
   */
  private finalize(): void {
    if (!this.merged) {
      this.merged = true;
      for (const [anonKey, userId] of this.aliases) {
        const anon = this.users.get(anonKey);
        if (!anon || anonKey === userId) continue;
        const target = this.users.get(userId);
        if (target) {
          target.screens.push(...anon.screens);
          target.prev.push(...anon.prev);
          target.times.push(...anon.times);
          target.dropped += anon.dropped;
          target.sorted = false;
        } else {
          this.users.set(userId, anon);
        }
        this.users.delete(anonKey);
      }
    }
    for (const timeline of this.users.values()) {
      if (timeline.sorted) continue;
      const order = timeline.times.map((_, i) => i);
      order.sort((a, b) => timeline.times[a] - timeline.times[b]);
      const screens = order.map(i => timeline.screens[i]);
      const prev = order.map(i => timeline.prev[i]);
      const times = order.map(i => timeline.times[i]);
      timeline.screens = screens;
      timeline.prev = prev;
      timeline.times = times;
      timeline.sorted = true;
    }
  }

  /**
   * Distinct users + raw events per screen, distinct users per transition, and
   * distinct users who left each screen — the exact analogues of the three
   * HogQL queries, but counted per person here so nothing double-counts.
   */
  toCounts(source: SourceId, dateRange?: string): Counts {
    this.finalize();

    const screenUsers = new Map<number, number>();
    const screenEvents = new Map<number, number>();
    const transitionUsers = new Map<string, number>();
    const leaverUsers = new Map<number, number>();

    // Per user, collapse to the SET of screens/transitions they touched, then
    // add 1 to each — that's a distinct-user count by construction.
    const seenScreens = new Set<number>();
    const seenTransitions = new Set<string>();
    const seenLeft = new Set<number>();
    for (const timeline of this.users.values()) {
      seenScreens.clear();
      seenTransitions.clear();
      seenLeft.clear();
      for (let i = 0; i < timeline.screens.length; i++) {
        const screen = timeline.screens[i];
        const prev = timeline.prev[i];
        screenEvents.set(screen, (screenEvents.get(screen) ?? 0) + 1);
        seenScreens.add(screen);
        if (prev >= 0) {
          seenTransitions.add(`${prev}>${screen}`);
          seenLeft.add(prev);
        }
      }
      for (const screen of seenScreens) {
        screenUsers.set(screen, (screenUsers.get(screen) ?? 0) + 1);
      }
      for (const pair of seenTransitions) {
        transitionUsers.set(pair, (transitionUsers.get(pair) ?? 0) + 1);
      }
      for (const screen of seenLeft) {
        leaverUsers.set(screen, (leaverUsers.get(screen) ?? 0) + 1);
      }
    }

    const screens: Record<string, ScreenCount> = {};
    for (const [id, users] of screenUsers) {
      screens[this.names[id]] = { users, events: screenEvents.get(id) ?? 0 };
    }

    const transitions: TransitionCount[] = [];
    for (const [pair, users] of transitionUsers) {
      const sep = pair.indexOf('>');
      const src = this.names[Number(pair.slice(0, sep))];
      const dst = this.names[Number(pair.slice(sep + 1))];
      if (src === undefined || dst === undefined) continue;
      transitions.push({ src, dst, users });
    }
    transitions.sort((a, b) => b.users - a.users);

    const leavers: Record<string, number> = {};
    for (const [id, users] of leaverUsers) {
      leavers[this.names[id]] = users;
    }

    return { source, date_range: dateRange, screens, transitions, leavers };
  }

  /**
   * Exact sequential funnel: distinct users who completed the first k ordered
   * steps (k = 1..N) within `windowSeconds` of starting the sequence. Same
   * semantics as ClickHouse `windowFunnel`, so live PostHog and this path
   * report comparable numbers.
   *
   * `stepKeys[i]` are the screen keys mapped to the i-th Atlas node — a user
   * seen under two aliases satisfies the step either way, and only once.
   */
  funnel(stepKeys: string[][], windowSeconds: number): number[] {
    this.finalize();
    const n = stepKeys.length;
    const cohort = new Array<number>(n).fill(0);
    if (n === 0) return cohort;

    // Interned key sets per step. A step whose keys were never seen in the
    // data can't be matched by anyone, which correctly zeroes the tail.
    const steps = stepKeys.map(keys => {
      const set = new Set<number>();
      for (const key of keys) {
        const id = this.ids.get(key);
        if (id !== undefined) set.add(id);
      }
      return set;
    });

    // chainStart[k] = start time of the best chain that has reached step k+1,
    // or -1 when the user hasn't reached it. Walking backwards means one
    // event can only advance one level per iteration, which is what keeps the
    // steps strictly ordered in time.
    const windowMs = windowSeconds * 1000;
    const chainStart = new Array<number>(n).fill(-1);
    for (const timeline of this.users.values()) {
      chainStart.fill(-1);
      let reached = 0;
      for (let i = 0; i < timeline.screens.length; i++) {
        const screen = timeline.screens[i];
        const t = timeline.times[i];
        for (let k = n - 1; k >= 1; k--) {
          if (chainStart[k - 1] < 0) continue;
          if (!steps[k].has(screen)) continue;
          if (t - chainStart[k - 1] > windowMs) continue;
          // Overwrite rather than keep the first chain: chain starts only move
          // forward in time, and a later start leaves more window for step k+1.
          chainStart[k] = chainStart[k - 1];
          if (k + 1 > reached) reached = k + 1;
        }
        // Restarting step 1 at the latest matching event gives later steps
        // the best chance of landing inside the window.
        if (steps[0].has(screen)) {
          chainStart[0] = t;
          if (reached < 1) reached = 1;
        }
      }
      for (let k = 0; k < reached; k++) cohort[k]++;
    }
    return cohort;
  }
}

/**
 * Parse a JSONL line into a RawEvent. Accepts both the vendor-export envelope
 * (`{event, properties:{…}}`) and a flat row (`{screen, distinct_id, …}`), so
 * an export from any tool can be fed in with minimal reshaping.
 * Returns null for blank lines, other events, or rows missing a screen/user.
 */
export function parseEventLine(
  line: string,
  opts: { appId?: string; eventName?: string } = {},
): RawEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const props =
    typeof row.properties === 'object' && row.properties !== null
      ? (row.properties as Record<string, unknown>)
      : row;
  // Identity and timing live inside `properties` for some exports (Mixpanel,
  // PostHog query rows) and on the envelope for others — the SDK's own
  // canonical event puts `screen` in properties but `distinct_id`/`device_id`/
  // `timestamp` on the outside. Look in both, or a custom destination's dump
  // parses as "no user" and every line is skipped.
  const field = (key: string): unknown => props[key] ?? row[key];

  const eventName = opts.eventName ?? 'atlas_screen';
  const name = typeof row.event === 'string' ? row.event : undefined;
  if (name !== undefined && name !== eventName) return null;

  if (opts.appId) {
    const appId = field('atlas_app_id');
    if (typeof appId === 'string' && appId !== opts.appId) return null;
  }

  const screen = field('screen');
  if (typeof screen !== 'string' || screen === '') return null;

  const userId = pickString(field('$user_id')) ?? pickString(field('user_id'));
  const deviceId = pickString(field('$device_id')) ?? pickString(field('device_id'));
  // distinct_id first: it's the vendor's own answer, already merged where the
  // vendor does that. userId/deviceId below let us merge it ourselves where
  // it doesn't.
  const user =
    pickString(field('distinct_id')) ??
    userId ??
    deviceId ??
    pickString(field('person_id'));
  if (!user) return null;

  const prevRaw = field('prev_screen');
  const prevScreen = typeof prevRaw === 'string' && prevRaw !== '' ? prevRaw : null;

  return {
    user,
    screen,
    prevScreen,
    timeMs: parseTime(field('time') ?? field('timestamp')),
    deviceId,
    userId,
  };
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Milliseconds since epoch from whatever the export carried: milliseconds, bare
 * seconds (Mixpanel's default export precision), or an ISO string. Unparseable
 * → 0, which sorts such events first rather than dropping them.
 */
export function parseTime(value: unknown): number {
  const scale = (n: number): number =>
    // Anything past ~year 2286 in seconds is really already milliseconds.
    n > 1e11 ? Math.floor(n) : Math.floor(n * 1000);
  if (typeof value === 'number' && Number.isFinite(value)) return scale(value);
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
    const n = Number(value);
    if (Number.isFinite(n)) return scale(n);
  }
  return 0;
}
