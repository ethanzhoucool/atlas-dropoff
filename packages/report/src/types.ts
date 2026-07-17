/* ============================================================
   Shared types for atlas-report.

   The Atlas shapes mirror atlas-funnel's data/<slug>/atlas.json;
   the analytics intermediate mirrors its analytics.json. Keeping
   those contracts identical means the render engine (a port of
   atlas-funnel's viewer) consumes them without translation.
   ============================================================ */

/* ── Normalized Atlas graph ─────────────────────────────────── */

export interface AtlasNode {
  id: string;
  /** display_name || semantic_name from the Atlas graph. */
  name: string;
  product_area: string;
  screen_kind: string | null;
  description: string | null;
  observation_count: number;
  is_entry_point: boolean;
  is_terminal: boolean;
  is_hub: boolean;
  primary_actions: string[];
  visible_labels: string[];
  rep_observation_id: string | null;
  /**
   * On disk (cache atlas.json): path relative to the cache dir, e.g.
   * "screens/<id>.png". In memory (after loadAtlas): absolute path,
   * or null when the screenshot is unavailable.
   */
  screenshot: string | null;
  rank: number;
  lane: string;
  parent_id: string | null;
  role: string | null;
}

export interface AtlasEdge {
  source: string;
  target: string;
  label: string | null;
  action_type: string | null;
  observation_count: number;
  session_support: number;
  /** True when the edge is part of Atlas's clean structural spine. */
  is_primary: boolean;
}

export interface AtlasGraph {
  app_id: string;
  app_name: string | null;
  stats: Record<string, unknown>;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

/* ── Counts (PostHog query result / --counts file) ──────────── */

export interface ScreenCount {
  users: number;
  events: number;
}

export interface TransitionCount {
  src: string;
  dst: string;
  users: number;
}

export interface Counts {
  source: 'posthog' | 'counts-file';
  /** Optional label override, e.g. "Last 28 days" (counts files may set it). */
  date_range?: string;
  screens: Record<string, ScreenCount>;
  transitions: TransitionCount[];
  /**
   * Optional: distinct users who navigated FROM each screen key to any next
   * screen. Enables an honest exit_rate (1 − leavers/users); when absent,
   * exit rates fall back to the per-destination sum approximation.
   */
  leavers?: Record<string, number>;
}

/* ── Screen mapping (PostHog keys → Atlas nodes) ────────────── */

export interface MatchedScreen {
  key: string;
  nodeId: string;
  nodeName: string;
  via: 'explicit' | 'exact' | 'normalized';
}

export interface Mapping {
  /** PostHog `screen` property value → Atlas node id. */
  screenToNode: Map<string, string>;
  matched: MatchedScreen[];
  unmatched: string[];
  /** --screen-map entries whose target no Atlas node matched. */
  explicitMisses: Array<{ key: string; target: string }>;
  nodesWithoutData: Array<{ id: string; name: string }>;
}

/* ── Analytics intermediate (mirrors atlas-funnel analytics.json) ── */

export interface FunnelStep {
  step: number;
  screen_id: string;
  screen_name: string;
  label: string;
  users: number;
  conversion_from_prev: number;
  drop_pct: number;
  lost: number;
  note: string;
}

export interface TopExit {
  /** Target Atlas node id, or "__exit__" for users who go nowhere next. */
  to: string;
  to_name: string;
  label: string;
  pct: number;
}

export interface Hotspot {
  cx: number;
  cy: number;
  w: number;
  h: number;
  label: string;
  kind: 'leak' | 'warn' | 'info';
}

export interface ScreenStats {
  screen_id: string;
  screen_name: string;
  users: number;
  events: number;
  exits: number;
  exit_rate: number;
  /** Not derivable from screen-view events alone — always null here.
      The renderer hides metric cells whose value is null. */
  median_time_s: number | null;
  rage_taps: number | null;
  avg_taps: number | null;
  top_exits: TopExit[];
  insight: string;
  hotspots: Hotspot[];
  in_funnel: boolean;
}

export interface BiggestLeak {
  screen_id: string;
  from_label: string;
  to_label: string;
  drop_pct: number;
  lost: number;
}

export interface Totals {
  sessions: number;
  converted: number;
  conversion_pct: number;
  screens_mapped: number;
  screens_with_data: number;
  biggest_leak: BiggestLeak | null;
}

export interface Analytics {
  source: 'posthog' | 'counts-file';
  disclaimer: string;
  app_id: string;
  date_range: string;
  totals: Totals;
  funnel: FunnelStep[];
  screens: Record<string, ScreenStats>;
}

/* ── Render payload (what the inlined viewer JS consumes) ───── */

export type Health = 'ok' | 'warn' | 'leak' | 'goal';

export interface RenderNode {
  id: string;
  name: string;
  title: string;
  product_area: string;
  description: string | null;
  /** data: URI, or null → the renderer draws a placeholder. */
  screenshot: string | null;
  col: number;
  row: number;
  in_funnel: boolean;
  step: number | null;
  is_goal: boolean;
  users: number;
  events: number;
  exits: number;
  exit_rate: number;
  median_time_s: number | null;
  rage_taps: number | null;
  avg_taps: number | null;
  top_exits: TopExit[];
  insight: string;
  hotspots: Hotspot[];
  health: Health;
}

export interface RenderEdge {
  source: string;
  target: string;
  kind: 'funnel' | 'side';
  health: Health | 'side';
  conversion?: number;
  drop?: number;
  lost?: number;
  users?: number;
}

export interface RenderPayload {
  app: { name: string; id: string; viewer: string };
  source: 'posthog' | 'counts-file';
  source_label: string;
  disclaimer: string;
  date_range: string;
  funnel_title: string;
  funnel_sub: string;
  totals: Totals;
  funnel: FunnelStep[];
  nodes: RenderNode[];
  edges: RenderEdge[];
}
