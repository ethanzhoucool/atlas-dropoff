/**
 * The capture / batch / transport singleton.
 *
 * Capture is vendor-neutral: one canonical event queue, fanned out at flush
 * time to every configured destination (PostHog, Amplitude, Mixpanel, or a
 * custom transport). Delivery is a plain `fetch` — no native modules, no
 * vendor SDKs, safe in Expo Go. Nothing in here ever throws into app code:
 * delivery failures are swallowed (and surfaced via console.warn when `debug`
 * is on), and one failing destination never blocks the others.
 */

import { AppState } from "react-native";
import type { NativeEventSubscription } from "react-native";
import { resolveDestinations } from "./destinations";
import type {
  AtlasDeliveryVerdict,
  AtlasDestination,
  AtlasDestinationRequest,
} from "./destinations/types";
import { defaultClassify } from "./destinations/types";
import { generateId, getOrCreateInstallId } from "./id";
import { createStorage } from "./storage";
import type { AtlasStorage } from "./storage";
import type {
  AtlasAnalyticsConfig,
  AtlasCapturedEvent,
  AtlasEventProperties,
  TrackScreenOptions,
} from "./types";

const SDK_NAME = "atlas-analytics-rn";
const SDK_VERSION = "0.2.0";
const SCREEN_EVENT = "atlas_screen";

const DEFAULT_FLUSH_AT = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const MIN_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
/** Hard cap so an offline session can't grow a queue unbounded. */
const MAX_QUEUE_SIZE = 500;

const IDENTIFIED_ID_KEY = "atlas_analytics.identified_id";

interface ResolvedConfig {
  atlasAppId: string;
  debug: boolean;
  flushAt: number;
  flushInterval: number;
  requestTimeout: number;
  normalizeScreen: (screen: string) => string;
}

export class AtlasClient {
  private readonly config: ResolvedConfig;
  private readonly destinations: AtlasDestination[];
  private readonly storage: AtlasStorage;
  private readonly flushTimer: ReturnType<typeof setInterval>;
  private readonly appStateSubscription: NativeEventSubscription | undefined;

  /** Captured-but-unsent events, shared by every destination. */
  private queue: AtlasCapturedEvent[] = [];
  /**
   * Per-destination retry buffers, keyed by destination name. A batch that
   * PostHog accepted but Amplitude 500'd sits here for Amplitude only — no
   * duplicate delivery to the destination that already took it.
   */
  private readonly pending = new Map<string, AtlasCapturedEvent[]>();
  private sessionId: string;
  private sessionStartedAt: number;
  private lastScreenKey: string | null = null;
  private flushing = false;
  /** The in-flight flush, so concurrent flush() callers can await it. */
  private flushPromise: Promise<void> = Promise.resolve();
  /**
   * Bumped on every identify()/reset(). Chained identity ops snapshot it at
   * call time and skip their distinctId/storage writes when a newer call has
   * superseded them, so a stale op can never clobber the current identity.
   */
  private identityEpoch = 0;

  /** Anonymous per-install id, loaded (or minted) from storage at init. */
  private installId: string | undefined;
  /** Current stamping id: identified user id, else the install id. */
  private distinctId: string | undefined;
  /**
   * Settles once the persisted ids are loaded. identify()/reset() chain their
   * storage work onto it so mutations apply in call order. Never rejects.
   */
  private identityReady: Promise<void>;

  constructor(config: AtlasAnalyticsConfig) {
    this.config = {
      atlasAppId: config.atlasAppId,
      debug: config.debug ?? false,
      flushAt: Math.max(1, config.flushAt ?? DEFAULT_FLUSH_AT),
      flushInterval: Math.max(
        MIN_FLUSH_INTERVAL_MS,
        config.flushInterval ?? DEFAULT_FLUSH_INTERVAL_MS
      ),
      requestTimeout: Math.max(
        1,
        config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS
      ),
      normalizeScreen: config.normalizeScreen ?? ((screen: string) => screen),
    };
    this.destinations = resolveDestinations(config);

    if (this.destinations.length === 0) {
      console.warn(
        "[atlas-analytics] no destination configured — events will be captured " +
          "but not delivered. Pass posthog / amplitude / mixpanel (or destinations: [...])."
      );
    }
    // Retry buffers are keyed by name, so duplicates would share one and
    // redeliver each other's failed batches.
    const names = new Set(this.destinations.map((d) => d.name));
    if (names.size !== this.destinations.length) {
      console.warn(
        "[atlas-analytics] two destinations share a name — give each " +
          "customDestination({ name }) a unique one, or retries will cross over."
      );
    }
    if (!this.config.atlasAppId) {
      console.warn(
        "[atlas-analytics] atlasAppId is empty — events won't join to your Atlas map."
      );
    }

    this.storage = createStorage();
    this.sessionId = generateId();
    this.sessionStartedAt = Date.now();
    this.identityReady = this.loadIdentity();

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushInterval);

    // Flush when the app is backgrounded so short sessions aren't lost.
    // Best effort: iOS/Android give a brief window for in-flight requests.
    // "inactive" is deliberately NOT a flush trigger — iOS fires it for
    // transient interruptions (app-switcher peek, Control Center) that would
    // cause redundant flushes.
    this.appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        void this.flush();
      }
    });
  }

  /** Names of the destinations this client delivers to, in send order. */
  get destinationNames(): string[] {
    return this.destinations.map((d) => d.name);
  }

  /**
   * Record a screen view. Consecutive duplicates are dropped, so it's safe to
   * wire this to both onReady and onStateChange, or to focus-style callbacks
   * that can re-fire for the same screen.
   */
  trackScreen(screen: string, options?: TrackScreenOptions): void {
    const resolved = options?.screenKeyOverride ?? screen;
    if (!resolved) {
      return;
    }
    // normalizeScreen is the config-wide escape hatch for collapsing dynamic
    // screen keys (e.g. `/users/123` → `/users/[id]`). It runs on the
    // resolved key — after screenKeyOverride, before dedupe — so it applies
    // uniformly to auto tracking, manual trackScreen() calls, and the React
    // Navigation helpers.
    let key: string;
    try {
      key = this.config.normalizeScreen(resolved);
    } catch (error) {
      key = resolved;
      this.warnDebug("normalizeScreen threw — using the raw key", error);
    }
    if (!key || key === this.lastScreenKey) {
      return;
    }

    const properties: AtlasEventProperties = {
      screen: key,
      prev_screen: this.lastScreenKey,
      $screen_name: key,
    };
    if (options?.title !== undefined) {
      properties.screen_title = options.title;
    }

    this.lastScreenKey = key;
    this.capture(SCREEN_EVENT, properties);
  }

  /** Capture an arbitrary custom event (still tagged with app/session/sdk). */
  track(event: string, properties?: AtlasEventProperties): void {
    if (!event) {
      return;
    }
    this.capture(event, properties ?? {});
  }

  /**
   * Attach a real user id. Every subsequent event carries both the user id and
   * the anonymous install id, which is what merges the pre-login history:
   * PostHog gets an explicit `$identify` with `$anon_distinct_id`, Amplitude
   * and Mixpanel merge from the device+user id pairing on each event. The id is
   * persisted so future launches keep it until `reset()`.
   */
  identify(userId: string, props?: AtlasEventProperties): void {
    if (!userId) {
      return;
    }
    // Same id with no props is a true no-op. Same id WITH props still sends a
    // $identify so the $set update reaches the (already identified) user.
    if (userId === this.distinctId && !props) {
      return;
    }
    // Freeze the transition at call time. The chained op below runs later, and
    // by then this.distinctId may have moved on (a rapid second identify(), a
    // reset()) — the $identify event must describe THIS call's from→to.
    const fromId = this.distinctId;
    const toId = userId;
    const epoch = ++this.identityEpoch;
    // Switch synchronously so events tracked right after identify() already
    // carry the user id. `fromId` may be undefined if the persisted id is
    // still loading — the chained op below falls back to the install id then.
    if (this.distinctId !== toId) {
      this.distinctId = toId;
    }

    this.identityReady = this.identityReady.then(async () => {
      const previous = fromId ?? this.installId;
      const properties: AtlasEventProperties = {};
      if (previous !== undefined && previous !== toId) {
        properties.$anon_distinct_id = previous;
      }
      if (props) {
        properties.$set = props;
      }
      if (properties.$anon_distinct_id !== undefined || props) {
        // Stamped with the frozen toId — never the mutable this.distinctId.
        this.capture("$identify", properties, toId);
      }
      // Persist only if no later identify()/reset() superseded this call.
      if (this.identityEpoch === epoch) {
        try {
          await this.storage.setItem(IDENTIFIED_ID_KEY, toId);
        } catch {
          // Memory-only storage — the identity just won't survive a restart.
        }
        this.logDebug(`identified as ${toId}`);
      }
    });
  }

  /**
   * Logout: drop the identified user id, go back to the anonymous install id,
   * and start a fresh session (so the next screen has `prev_screen: null`).
   */
  reset(): void {
    // Session + screen chain rotate synchronously so the very next
    // trackScreen() call is already attributed to the new session.
    this.sessionId = generateId();
    this.sessionStartedAt = Date.now();
    this.lastScreenKey = null;
    const epoch = ++this.identityEpoch;
    // Unconditional: may set undefined while installId is still loading —
    // that's correct, post-reset events must never carry the stale identified
    // id. The flush-time restamp (and the chained op below) fill in the
    // install id once it's available.
    this.distinctId = this.installId;
    this.identityReady = this.identityReady.then(async () => {
      if (this.identityEpoch !== epoch) {
        // A later identify() (or reset()) superseded this one — applying the
        // install id now would clobber the newer identity.
        return;
      }
      this.distinctId = this.installId; // covers a reset() while ids were loading
      try {
        await this.storage.removeItem(IDENTIFIED_ID_KEY);
      } catch {
        // Ignore — worst case the old id resurfaces next launch.
      }
      this.logDebug("reset — anonymous install id restored, new session started");
    });
  }

  /** Send everything queued right now. Resolves when the attempt finishes. */
  async flush(): Promise<void> {
    if (this.flushing) {
      // Piggyback on the in-flight flush so callers (and shutdown()) actually
      // wait for the attempt to finish instead of resolving immediately.
      return this.flushPromise;
    }
    this.flushing = true;
    this.flushPromise = this.doFlush();
    return this.flushPromise;
  }

  private async doFlush(): Promise<void> {
    try {
      // Await the identity chain BEFORE checking the queue: a just-called
      // identify()/reset() may still be about to enqueue its $identify.
      // identityReady never rejects, so this is safe.
      await this.identityReady;
      const batch = this.queue.splice(0, this.queue.length);
      const hasPending = [...this.pending.values()].some((b) => b.length > 0);
      if (batch.length === 0 && !hasPending) {
        return;
      }
      // Stamp any events captured before the persisted ids finished loading.
      for (const item of batch) {
        if (!item.device_id) {
          item.device_id = this.installId ?? "anonymous";
        }
        if (!item.distinct_id) {
          item.distinct_id = this.distinctId ?? item.device_id;
        }
      }

      // Every destination attempts independently: one vendor being down can't
      // hold up (or duplicate) delivery to the others.
      await Promise.all(
        this.destinations.map(async (destination) => {
          const carried = this.pending.get(destination.name) ?? [];
          const events = carried.length > 0 ? carried.concat(batch) : batch;
          if (events.length === 0) return;
          this.pending.set(destination.name, []);

          const verdict = await this.deliver(destination, events);
          if (verdict === "retry") {
            this.requeue(destination.name, events);
            this.warnDebug(
              `${destination.name}: delivery failed — ${events.length} event(s) requeued`
            );
          } else if (verdict === "drop") {
            this.warnDebug(
              `${destination.name}: dropping ${events.length} event(s) (permanent failure)`
            );
          } else {
            this.logDebug(`${destination.name}: flushed ${events.length} event(s)`);
          }
        })
      );
    } finally {
      this.flushing = false;
    }
  }

  /** One delivery attempt for one destination. Never throws. */
  private async deliver(
    destination: AtlasDestination,
    events: AtlasCapturedEvent[]
  ): Promise<AtlasDeliveryVerdict> {
    if (destination.send) {
      try {
        return await destination.send(events);
      } catch (error) {
        this.warnDebug(`${destination.name}: send() threw`, error);
        return "retry";
      }
    }

    let requests: AtlasDestinationRequest[];
    try {
      requests = destination.buildRequests(events);
    } catch (error) {
      // Non-serializable custom properties, or a mapper bug. Dropping beats
      // retrying the same bytes forever.
      this.warnDebug(
        `${destination.name}: could not build the request — dropping batch`,
        error
      );
      return "drop";
    }
    if (requests.length === 0) {
      return "ok"; // nothing this vendor wants from these events
    }

    for (const request of requests) {
      const verdict = await this.send(destination, request);
      // A partial failure retries the whole batch for this destination; the
      // per-event insert ids make the redelivered half a dedupe, not a double
      // count.
      if (verdict !== "ok") return verdict;
    }
    return "ok";
  }

  private async send(
    destination: AtlasDestination,
    request: AtlasDestinationRequest
  ): Promise<AtlasDeliveryVerdict> {
    let response: Response;
    // Abort a stalled request after requestTimeout — without this, a hung
    // connection would never settle, `flushing` would stay true forever,
    // and delivery would be dead for the rest of the process lifetime.
    const abort = new AbortController();
    const abortTimer = setTimeout(
      () => abort.abort(),
      this.config.requestTimeout
    );
    try {
      response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: abort.signal,
      });
    } catch (error) {
      // Includes the AbortError from the timeout above — treated like any
      // transient network failure: keep the events for the next flush.
      this.warnDebug(`${destination.name}: network error while flushing`, error);
      return "retry";
    } finally {
      clearTimeout(abortTimer);
    }

    let body = "";
    if (destination.inspectBody && typeof response.text === "function") {
      body = await response.text().catch(() => "");
    }
    const classify = destination.classify ?? defaultClassify;
    const verdict = classify(response.status, body);
    if (verdict !== "ok") {
      this.warnDebug(
        `${destination.name}: HTTP ${response.status} → ${verdict}`,
        body.slice(0, 200)
      );
    }
    return verdict;
  }

  /**
   * Stop background work (interval + AppState listener) after a final flush.
   * Rarely needed in apps — the client is meant to live as long as the app —
   * but useful in tests and hot-reload environments.
   */
  async shutdown(): Promise<void> {
    clearInterval(this.flushTimer);
    this.appStateSubscription?.remove();
    // Drain: wait out any in-flight flush (events captured during it stay
    // queued), then flush once more so nothing is left behind.
    await this.flushPromise;
    await this.flush();
  }

  private capture(
    event: string,
    properties: AtlasEventProperties,
    distinctIdOverride?: string
  ): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.shift(); // Drop the oldest — recent behavior matters more.
    }
    // An explicit override (identify()'s frozen target id) always wins;
    // otherwise stamped at flush time if identity hasn't loaded yet. The
    // flush-time restamp only fills EMPTY ids, so overrides survive it.
    const effectiveId = distinctIdOverride ?? this.distinctId ?? "";
    this.queue.push({
      event,
      distinct_id: effectiveId,
      device_id: this.installId ?? "",
      // Anything other than the install id IS an identified id. While the
      // install id is still loading, a non-empty effective id can only have
      // come from identify().
      user_id:
        effectiveId && effectiveId !== this.installId ? effectiveId : null,
      insert_id: generateId(),
      timestamp: new Date().toISOString(),
      session_started_at: this.sessionStartedAt,
      properties: {
        ...properties,
        // Contract fields last, so custom properties can never clobber them.
        atlas_app_id: this.config.atlasAppId,
        session_id: this.sessionId,
        sdk: SDK_NAME,
        sdk_version: SDK_VERSION,
      },
    });
    this.logDebug(`captured ${event}`, properties);

    if (this.queue.length >= this.config.flushAt) {
      void this.flush();
    }
  }

  private async loadIdentity(): Promise<void> {
    this.installId = await getOrCreateInstallId(this.storage);
    let identified: string | null = null;
    try {
      identified = await this.storage.getItem(IDENTIFIED_ID_KEY);
    } catch {
      // Treat as anonymous.
    }
    // Don't clobber an identify() that already ran while this was loading.
    if (this.distinctId === undefined) {
      this.distinctId = identified ?? this.installId;
    }
  }

  private requeue(name: string, batch: AtlasCapturedEvent[]): void {
    const existing = this.pending.get(name) ?? [];
    let merged = batch.concat(existing);
    if (merged.length > MAX_QUEUE_SIZE) {
      merged = merged.slice(merged.length - MAX_QUEUE_SIZE);
    }
    this.pending.set(name, merged);
  }

  private logDebug(message: string, ...extra: unknown[]): void {
    if (this.config.debug) {
      console.log(`[atlas-analytics] ${message}`, ...extra);
    }
  }

  private warnDebug(message: string, ...extra: unknown[]): void {
    if (this.config.debug) {
      console.warn(`[atlas-analytics] ${message}`, ...extra);
    }
  }
}

let sharedClient: AtlasClient | undefined;
let warnedUninitialized = false;

/**
 * Initialize the shared client. Idempotent: the first call wins and later
 * calls return the existing client (so <AtlasProvider> is StrictMode-safe).
 */
export function initAtlasAnalytics(config: AtlasAnalyticsConfig): AtlasClient {
  if (sharedClient) {
    if (config.debug) {
      console.warn(
        "[atlas-analytics] initAtlasAnalytics called more than once — keeping the existing client."
      );
    }
    return sharedClient;
  }
  sharedClient = new AtlasClient(config);
  return sharedClient;
}

/** The shared client, or undefined (with a one-time warning) if not initialized. */
export function getClient(): AtlasClient | undefined {
  if (!sharedClient && !warnedUninitialized) {
    warnedUninitialized = true;
    console.warn(
      "[atlas-analytics] Not initialized — wrap your app in <AtlasProvider> or call initAtlasAnalytics() first."
    );
  }
  return sharedClient;
}
