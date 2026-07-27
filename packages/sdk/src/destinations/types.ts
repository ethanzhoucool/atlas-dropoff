/**
 * The destination contract.
 *
 * A destination turns a batch of canonical Atlas events into HTTP requests for
 * one analytics vendor. The client owns queueing, batching, retries and
 * identity; a destination is a pure(ish) payload mapper, which is what keeps
 * "add another vendor" a ~80-line file instead of a fork of the client.
 */

import type { AtlasCapturedEvent } from "../types";

/** One HTTP request the client should send on the destination's behalf. */
export interface AtlasDestinationRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * What the client should do with a batch after an attempt.
 * - `ok`    — delivered, drop it
 * - `retry` — transient (network, 429, 5xx); keep it for the next flush
 * - `drop`  — permanent (bad key, malformed payload); retrying would loop
 */
export type AtlasDeliveryVerdict = "ok" | "retry" | "drop";

export interface AtlasDestination {
  /** Stable id used in debug logs and per-destination retry buffers. */
  readonly name: string;
  /**
   * Max events per HTTP request. The client chunks larger batches; each chunk
   * is one request and they're sent sequentially.
   */
  readonly maxBatchSize?: number;
  /**
   * Set when the verdict depends on the response body (Mixpanel answers 200
   * with a literal `0` when every event was rejected). The client only reads
   * the body for destinations that ask for it.
   */
  readonly inspectBody?: boolean;
  /**
   * Map a chunk of canonical events to HTTP requests. Return `[]` to drop the
   * chunk silently (e.g. a vendor with no equivalent of `$identify`).
   */
  buildRequests(batch: AtlasCapturedEvent[]): AtlasDestinationRequest[];
  /** Classify a response. Defaults to `defaultClassify` when omitted. */
  classify?(status: number, body: string): AtlasDeliveryVerdict;
  /**
   * Full custom transport. When present, the client calls this instead of
   * buildRequests/fetch — the escape hatch for a warehouse, a Segment-style
   * proxy, or any vendor not shipped here.
   */
  send?(batch: AtlasCapturedEvent[]): Promise<AtlasDeliveryVerdict>;
}

/** 2xx delivered · 429/5xx transient · everything else permanent. */
export function defaultClassify(status: number): AtlasDeliveryVerdict {
  if (status >= 200 && status < 300) return "ok";
  if (status === 429 || status >= 500) return "retry";
  return "drop";
}

/** Split a batch into chunks of at most `size` events. */
export function chunk<T>(items: T[], size: number | undefined): T[][] {
  if (!size || size <= 0 || items.length <= size) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Event properties minus the PostHog-specific `$`-prefixed keys. Every vendor
 * gets the frozen contract fields (screen, prev_screen, atlas_app_id,
 * session_id, sdk, …) plus whatever custom properties the app passed; only the
 * PostHog dialect (`$set`, `$anon_distinct_id`, `$screen_name`) is stripped.
 */
export function vendorProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key.charCodeAt(0) === 36 /* $ */) continue;
    out[key] = value;
  }
  return out;
}

/** Milliseconds since epoch from the event's ISO timestamp (NaN-safe). */
export function epochMillis(event: AtlasCapturedEvent): number {
  const ms = Date.parse(event.timestamp);
  return Number.isFinite(ms) ? ms : Date.now();
}
