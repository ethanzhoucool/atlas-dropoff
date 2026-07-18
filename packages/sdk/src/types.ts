/**
 * Public types for @ethanzhoucool/atlas-analytics.
 */

/** Configuration accepted by `initAtlasAnalytics()` and `<AtlasProvider>`. */
export interface AtlasAnalyticsConfig {
  /** PostHog project API key (`phc_...`). */
  apiKey: string;
  /**
   * Revyl Atlas app id. Stamped on every event as `atlas_app_id` — this is
   * how the drop-off report joins events to your Atlas map.
   */
  atlasAppId: string;
  /**
   * PostHog ingestion host. Defaults to `https://us.i.posthog.com`
   * (use `https://eu.i.posthog.com` for EU Cloud).
   */
  host?: string;
  /** Log SDK activity and delivery warnings to the console. Default: false. */
  debug?: boolean;
  /** Flush as soon as this many events are queued. Default: 20. */
  flushAt?: number;
  /** Flush every N milliseconds. Default: 5000. Minimum: 1000. */
  flushInterval?: number;
  /**
   * Abort a delivery request after this many milliseconds; the batch is
   * requeued and retried on the next flush, like any transient network
   * failure. Default: 10000.
   */
  requestTimeout?: number;
  /**
   * Rewrite a screen key before it's deduped and captured — the
   * general-purpose way to collapse dynamic screens into one canonical key
   * that joins to a single Atlas node (e.g. `/users/123` → `/users/[id]` for
   * React Navigation route params). Applied uniformly to every path — auto
   * tracking, manual `trackScreen()`, and the React Navigation helpers —
   * after a per-call `screenKeyOverride` is resolved.
   */
  normalizeScreen?: (screen: string) => string;
}

/** Options for `trackScreen()`. */
export interface TrackScreenOptions {
  /** Human-readable label, sent as `screen_title`. */
  title?: string;
  /**
   * Use a different canonical key than the route name/pathname — e.g. to
   * collapse `/product/42` and `/product/7` into `/product/[id]`.
   */
  screenKeyOverride?: string;
}

/** Free-form event properties. Must be JSON-serializable. */
export type AtlasEventProperties = Record<string, unknown>;

/**
 * The exact property payload of every `atlas_screen` event.
 * A separate report generator depends on this shape — do not change casually.
 */
export interface AtlasScreenEventProperties {
  /**
   * Canonical screen key: route name (React Navigation) or route pattern
   * (Expo Router — e.g. `/product/[id]`, built from segments so dynamic
   * routes collapse to one key).
   */
  screen: string;
  /** Human-readable label, when available. */
  screen_title?: string;
  /** Previous screen key, or null on the first screen of a session. */
  prev_screen: string | null;
  /** Revyl Atlas app id, from config. */
  atlas_app_id: string;
  /** Per-app-launch session id (rotates on `reset()`). */
  session_id: string;
  sdk: "atlas-analytics-rn";
  sdk_version: string;
  /**
   * Mirrors the screen key as a plain property for PostHog filtering. (Note:
   * PostHog's native "Screens" UI keys off events literally named `$screen`,
   * which this SDK does not emit.)
   */
  $screen_name: string;
}

/** One event as it appears in the `batch` array POSTed to PostHog. */
export interface AtlasCapturedEvent {
  event: string;
  distinct_id: string;
  /** ISO 8601 timestamp, captured at enqueue time. */
  timestamp: string;
  properties: AtlasEventProperties;
}

/**
 * The minimal slice of a React Navigation container ref that the SDK needs.
 * Structural on purpose: any `NavigationContainerRef` (from
 * `useNavigationContainerRef()` / `createNavigationContainerRef()`) satisfies
 * it without this package importing `@react-navigation/native` types.
 */
export interface AtlasNavigationRef {
  isReady?(): boolean;
  getCurrentRoute?(): { name?: string; key?: string } | undefined;
  addListener?(event: "state", callback: () => void): () => void;
}
