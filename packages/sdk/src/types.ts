/**
 * Public types for @revyl/atlas-analytics.
 */

import type { AmplitudeDestinationConfig } from "./destinations/amplitude";
import type { MixpanelDestinationConfig } from "./destinations/mixpanel";
import type { PostHogDestinationConfig } from "./destinations/posthog";
import type { AtlasDestination } from "./destinations/types";

/** Configuration accepted by `initAtlasAnalytics()` and `<AtlasProvider>`. */
export interface AtlasAnalyticsConfig {
  /**
   * Revyl Atlas app id. Stamped on every event as `atlas_app_id` — this is
   * how the drop-off report joins events to your Atlas map.
   */
  atlasAppId: string;

  /* ── where the events go (at least one) ───────────────────────────────── */

  /** Send to PostHog. */
  posthog?: PostHogDestinationConfig;
  /** Send to Amplitude. */
  amplitude?: AmplitudeDestinationConfig;
  /** Send to Mixpanel. */
  mixpanel?: MixpanelDestinationConfig;
  /**
   * Extra destinations — `customDestination({ name, send })` for anything not
   * shipped here (Segment, RudderStack, your own collector). Combined with the
   * shorthands above, so an app can dual-write during a migration.
   */
  destinations?: AtlasDestination[];
  /**
   * Data region for every destination that didn't set an explicit `host`.
   * Default: `"us"`.
   */
  region?: "us" | "eu";

  /**
   * Legacy PostHog project API key (`phc_...`), equivalent to
   * `posthog: { apiKey }`. Ignored when `posthog` is set.
   */
  apiKey?: string;
  /** Legacy PostHog ingestion host, equivalent to `posthog: { host }`. */
  host?: string;

  /* ── behavior ─────────────────────────────────────────────────────────── */

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
 * Every destination sends these same fields; only the envelope around them
 * (identity, timestamps) is vendor-specific.
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
   * which this SDK does not emit.) Stripped from Amplitude/Mixpanel payloads
   * along with the rest of the `$`-prefixed PostHog dialect.
   */
  $screen_name: string;
}

/**
 * One captured event, in the SDK's canonical (vendor-neutral) form.
 * Destinations map this into their own envelope.
 */
export interface AtlasCapturedEvent {
  event: string;
  /**
   * The vendor-facing id: the identified user id when known, else the
   * anonymous install id. (PostHog's `distinct_id`; Mixpanel's `distinct_id`,
   * which is prefixed `$device:` while anonymous.)
   */
  distinct_id: string;
  /** Anonymous per-install id. Amplitude `device_id` / Mixpanel `$device_id`. */
  device_id: string;
  /** Identified user id, or null while anonymous. */
  user_id: string | null;
  /** Stable per capture, so a retried batch dedupes instead of double-counting. */
  insert_id: string;
  /** ISO 8601 timestamp, captured at enqueue time. */
  timestamp: string;
  /** Session start in ms since epoch — Amplitude's numeric `session_id`. */
  session_started_at: number;
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
