/**
 * Custom destination — the escape hatch.
 *
 * Anything the built-ins don't cover (Segment, RudderStack, Snowplow, your own
 * collector, a warehouse) is a `send` function away. The client owns batching
 * and retries: throw (or resolve `false`) to have the batch requeued for the
 * next flush. Only the chunks you haven't accepted are retried, but delivery
 * is still at-least-once — a `send` that reaches the collector and then fails
 * on the way back will be retried. Dedupe on the receiving end by
 * `insert_id`, which is stable per capture.
 */

import type { AtlasCapturedEvent } from "../types";
import type { AtlasDeliveryVerdict, AtlasDestination } from "./types";

export interface CustomDestinationConfig {
  /** Shown in debug logs; also keys this destination's retry buffer. */
  name: string;
  /**
   * Deliver a batch. Resolve (or resolve `true`) on success; throw or resolve
   * `false` to retry on the next flush; resolve `"drop"` to discard the batch
   * permanently.
   */
  send(batch: AtlasCapturedEvent[]): Promise<void | boolean | AtlasDeliveryVerdict>;
  /** Max events per `send` call. Default: unlimited (one call per flush). */
  maxBatchSize?: number;
}

export function customDestination(
  config: CustomDestinationConfig
): AtlasDestination {
  return {
    name: config.name,
    maxBatchSize: config.maxBatchSize,
    buildRequests(): [] {
      return []; // unused — `send` takes over
    },
    async send(batch: AtlasCapturedEvent[]): Promise<AtlasDeliveryVerdict> {
      try {
        const result = await config.send(batch);
        if (result === false) return "retry";
        if (result === "retry" || result === "drop") return result;
        return "ok";
      } catch {
        return "retry";
      }
    },
  };
}
