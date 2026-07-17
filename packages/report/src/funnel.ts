/* ============================================================
   funnel.ts — join mapped PostHog counts onto the Atlas graph
   and compute the drop-off analytics intermediate (the same
   shape as atlas-funnel's analytics.json).

   The Atlas graph IS the funnel definition: start at the busiest
   entry screen and follow the highest-volume observed transition
   at every hop until a terminal screen (or a dead end).
   ============================================================ */

import type {
  Analytics, AtlasEdge, AtlasGraph, AtlasNode, BiggestLeak, Counts, FunnelStep,
  Mapping, ScreenStats, TopExit, Totals,
} from './types.js';

const MAX_FUNNEL_STEPS = 24;
const TOP_EXITS_SHOWN = 3;

export interface ComputeOptions {
  dateRange: string;
  disclaimer: string;
}

/* ── small shared helpers ───────────────────────────────────── */

export function healthOf(rate: number): 'leak' | 'warn' | 'ok' {
  return rate >= 0.18 ? 'leak' : rate >= 0.12 ? 'warn' : 'ok';
}

/** "onboarding_id_capture_front" (area "Onboarding") → "Id Capture Front". */
export function prettyName(node: AtlasNode): string {
  const raw = (node.name || node.id).replace(/[_\-\\/]+/g, ' ').trim();
  const parts = raw.split(/\s+/);
  const area = normalizeWord(node.product_area);
  if (parts.length > 1 && normalizeWord(parts[0]) === area) parts.shift();
  return parts.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function normalizeWord(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function humanizeAction(label: string): string {
  const s = label.replace(/[_-]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const fmtInt = (n: number): string => n.toLocaleString('en-US');
const pctStr = (x: number): string => `${Math.round(x * 100)}%`;

/* ── transitions keyed by Atlas node ids ────────────────────── */

/**
 * Aggregate PostHog (src,dst) transition counts onto Atlas node ids.
 * Transitions with an unmapped endpoint (or self-loops) are dropped.
 */
export function buildNodeTransitions(
  counts: Counts,
  mapping: Mapping,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const t of counts.transitions) {
    const src = mapping.screenToNode.get(t.src);
    const dst = mapping.screenToNode.get(t.dst);
    if (!src || !dst || src === dst || t.users <= 0) continue;
    let inner = out.get(src);
    if (!inner) {
      inner = new Map<string, number>();
      out.set(src, inner);
    }
    inner.set(dst, (inner.get(dst) ?? 0) + t.users);
  }
  return out;
}

/* ── main compute ───────────────────────────────────────────── */

export function computeAnalytics(
  atlas: AtlasGraph,
  counts: Counts,
  mapping: Mapping,
  transitions: Map<string, Map<string, number>>,
  opts: ComputeOptions,
): Analytics {
  const byId = new Map<string, AtlasNode>(atlas.nodes.map(n => [n.id, n]));

  // Distinct users / raw events per Atlas node (multiple PostHog keys
  // mapping to one node are summed).
  const users = new Map<string, number>();
  const events = new Map<string, number>();
  for (const [key, c] of Object.entries(counts.screens)) {
    const id = mapping.screenToNode.get(key);
    if (!id) continue;
    users.set(id, (users.get(id) ?? 0) + c.users);
    events.set(id, (events.get(id) ?? 0) + c.events);
  }
  if (users.size === 0) {
    throw new Error(
      'No PostHog screen keys matched any Atlas node — nothing to report. ' +
      'Pass --screen-map to map your event keys onto Atlas screens.',
    );
  }

  // Best Atlas edge per (src,dst) pair — used for transition labels.
  const edgeByPair = new Map<string, AtlasEdge>();
  for (const e of atlas.edges) {
    const k = `${e.source}|${e.target}`;
    const cur = edgeByPair.get(k);
    const better =
      !cur ||
      (e.is_primary && !cur.is_primary) ||
      (e.is_primary === cur.is_primary && e.observation_count > cur.observation_count);
    if (better) edgeByPair.set(k, e);
  }

  const path = buildFunnelPath(atlas, byId, users, transitions);
  const inFunnel = new Set(path);
  const goalId = path[path.length - 1];

  /* funnel steps — conversion between consecutive steps uses the ACTUAL
     observed transition count (users who traversed step_{i-1} → step_i)
     when transition data exists; the population ratio users_i/users_{i-1}
     is only a fallback (it compares total viewers, not real traversals). */
  const steps: FunnelStep[] = path.map((id, i) => {
    const node = byId.get(id)!;
    const u = users.get(id) ?? 0;
    if (i === 0) {
      return {
        step: 1,
        screen_id: id,
        screen_name: node.name,
        label: prettyName(node),
        users: u,
        conversion_from_prev: 1,
        drop_pct: 0,
        lost: 0,
        note: '',
      };
    }
    const prevId = path[i - 1];
    const prevU = users.get(prevId) ?? 0;
    const transU = transitions.get(prevId)?.get(id);
    let conv: number;
    let lost: number;
    if (transU !== undefined && transU > 0 && prevU > 0) {
      conv = Math.min(1, transU / prevU);
      lost = Math.max(0, prevU - transU);
    } else {
      conv = prevU > 0 ? Math.min(1, u / prevU) : 0;
      lost = Math.max(0, prevU - u);
    }
    return {
      step: i + 1,
      screen_id: id,
      screen_name: node.name,
      label: prettyName(node),
      users: u,
      conversion_from_prev: round3(conv),
      drop_pct: round3(Math.max(0, 1 - conv)),
      lost,
      note: '',
    };
  });

  /* biggest leak (attributed to the screen users leave) */
  let biggestIdx = -1;
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].drop_pct <= 0) continue;
    if (biggestIdx === -1 || steps[i].drop_pct > steps[biggestIdx].drop_pct) biggestIdx = i;
  }
  const biggest: BiggestLeak | null =
    biggestIdx === -1
      ? null
      : {
          screen_id: steps[biggestIdx - 1].screen_id,
          from_label: steps[biggestIdx - 1].label,
          to_label: steps[biggestIdx].label,
          drop_pct: steps[biggestIdx].drop_pct,
          lost: steps[biggestIdx].lost,
        };

  /* notes */
  steps[0].note = `Funnel entry — ${fmtInt(steps[0].users)} distinct users in the window.`;
  for (let i = 1; i < steps.length; i++) {
    const s = steps[i];
    const prevLabel = steps[i - 1].label;
    s.note =
      (i === biggestIdx ? 'Biggest leak. ' : '') +
      (s.drop_pct > 0
        ? `−${Math.round(s.drop_pct * 100)}% from “${prevLabel}” — ${fmtInt(s.lost)} users lost.`
        : `No measurable drop from “${prevLabel}”.`);
  }

  /* per-screen stats for every node that saw traffic */
  const sessions = steps[0].users;
  const converted = steps[steps.length - 1].users;
  const screens: Record<string, ScreenStats> = {};

  /* distinct "leavers" (users who navigated FROM the screen to any next
     screen) per Atlas node, when the counts source provides them. Summing
     per-destination transition counts instead double-counts users who left
     to multiple destinations and biases exit rates LOW. */
  const leaversByNode = new Map<string, number>();
  if (counts.leavers) {
    for (const [key, n] of Object.entries(counts.leavers)) {
      const id = mapping.screenToNode.get(key);
      if (!id || n <= 0) continue;
      leaversByNode.set(id, (leaversByNode.get(id) ?? 0) + n);
    }
  }

  for (const node of atlas.nodes) {
    const u = users.get(node.id) ?? 0;
    if (u <= 0) continue;

    const outs = transitions.get(node.id) ?? new Map<string, number>();
    let outTotal = 0;
    for (const v of outs.values()) outTotal += v;
    const movedOn = counts.leavers ? leaversByNode.get(node.id) ?? 0 : outTotal;
    const exitShare = Math.max(0, 1 - movedOn / u);
    const exits = Math.round(u * exitShare);

    const topExits: TopExit[] = [...outs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_EXITS_SHOWN)
      .map(([dst, du]) => {
        const dstNode = byId.get(dst);
        const edge = edgeByPair.get(`${node.id}|${dst}`);
        return {
          to: dst,
          to_name: dstNode?.name ?? dst,
          label: edge?.label
            ? humanizeAction(edge.label)
            : `Went to ${dstNode ? prettyName(dstNode) : dst}`,
          pct: round3(Math.min(1, du / u)),
        };
      });
    if (exitShare > 0.005) {
      topExits.push({ to: '__exit__', to_name: '__exit__', label: 'Left the app', pct: round3(exitShare) });
    }

    const isGoal = node.id === goalId;
    screens[node.id] = {
      screen_id: node.id,
      screen_name: node.name,
      users: u,
      events: events.get(node.id) ?? 0,
      exits,
      exit_rate: round3(exitShare),
      median_time_s: null, // not derivable from screen-view events
      rage_taps: null,
      avg_taps: null,
      top_exits: topExits,
      insight: insightFor(node, u, exitShare, isGoal, biggest?.screen_id === node.id, sessions),
      hotspots: [],
      in_funnel: inFunnel.has(node.id),
    };
  }

  const totals: Totals = {
    sessions,
    converted,
    conversion_pct: Math.min(
      100,
      Math.max(0, Math.round((converted / Math.max(1, sessions)) * 1000) / 10),
    ),
    screens_mapped: atlas.nodes.length,
    screens_with_data: users.size,
    biggest_leak: biggest,
  };

  return {
    source: counts.source,
    disclaimer: opts.disclaimer,
    app_id: atlas.app_id,
    date_range: opts.dateRange,
    totals,
    funnel: steps,
    screens,
  };
}

/* ── funnel path discovery ──────────────────────────────────── */

/**
 * Start at the busiest entry-point screen with data — unless that entry
 * point is a low-traffic splash (<50% of the busiest screen's users), in
 * which case start at the busiest screen overall so step 2 can never dwarf
 * step 1 (>100% conversions). Then repeatedly follow the highest-volume
 * observed transition to an unvisited screen with data.
 * If PostHog recorded no transitions at all (e.g. a screens-only counts
 * file), walk the Atlas structure instead: primary edges first, then by
 * observation count.
 */
function buildFunnelPath(
  atlas: AtlasGraph,
  byId: Map<string, AtlasNode>,
  users: Map<string, number>,
  transitions: Map<string, Map<string, number>>,
): string[] {
  const withData = atlas.nodes.filter(n => (users.get(n.id) ?? 0) > 0);
  const u = (n: AtlasNode): number => users.get(n.id) ?? 0;
  const busiest = withData.reduce((a, b) => (u(b) > u(a) ? b : a));
  const entries = withData.filter(n => n.is_entry_point);
  let start = busiest;
  if (entries.length) {
    const busiestEntry = entries.reduce((a, b) => (u(b) > u(a) ? b : a));
    if (u(busiestEntry) >= u(busiest) * 0.5) start = busiestEntry;
  }
  let cur = start.id;

  const hasTransitions = [...transitions.values()].some(m => m.size > 0);
  const path = [cur];
  const visited = new Set([cur]);

  while (path.length < MAX_FUNNEL_STEPS) {
    let next: string | null = null;

    if (hasTransitions) {
      const outs = transitions.get(cur);
      if (outs) {
        let best = 0;
        for (const [dst, u] of outs) {
          if (visited.has(dst) || (users.get(dst) ?? 0) <= 0) continue;
          if (u > best) {
            best = u;
            next = dst;
          }
        }
      }
    } else {
      const candidates = atlas.edges
        .filter(e => e.source === cur && !visited.has(e.target) && (users.get(e.target) ?? 0) > 0)
        .sort(
          (a, b) =>
            Number(b.is_primary) - Number(a.is_primary) ||
            b.observation_count - a.observation_count,
        );
      next = candidates.length ? candidates[0].target : null;
    }

    if (!next) break;
    path.push(next);
    visited.add(next);
    // With real transition data, follow the observed flow to its dead end —
    // Atlas can over-mark screens as terminal (an exploration happened to end
    // there), so an `is_terminal` flag mustn't cut a live funnel short. When we
    // have no transitions and are walking the Atlas structure, respect it.
    if (!hasTransitions && byId.get(next)?.is_terminal) break;
    cur = next;
  }
  return path;
}

/* ── rule-based screen insights ─────────────────────────────── */

function insightFor(
  node: AtlasNode,
  u: number,
  exitShare: number,
  isGoal: boolean,
  isBiggestLeakSource: boolean,
  sessions: number,
): string {
  if (isGoal) {
    return `Funnel goal. ${fmtInt(u)} of ${fmtInt(sessions)} users who entered the flow made it here (${pctStr(u / Math.max(1, sessions))}).`;
  }
  const h = healthOf(exitShare);
  if (h === 'leak') {
    return (
      `${pctStr(exitShare)} of users who reach this screen go nowhere next — ` +
      (isBiggestLeakSource ? 'the single biggest leak in the funnel. ' : 'a major leak. ') +
      'Watch PostHog session replays for this screen and re-run the step in Revyl Atlas.'
    );
  }
  if (h === 'warn') {
    return `Noticeable drop-off: ${pctStr(exitShare)} of users stop here. Worth a closer look before it grows.`;
  }
  return 'Healthy pass-through — most users continue without friction.';
}
