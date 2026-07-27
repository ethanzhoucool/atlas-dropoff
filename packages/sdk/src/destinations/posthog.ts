/**
 * PostHog destination — POST /batch/ (the original transport).
 *
 * PostHog is the only vendor here that models anonymous→identified merging as
 * an explicit `$identify` event carrying `$anon_distinct_id`, so it's the only
 * one that forwards the event untouched.
 */

import type { AtlasCapturedEvent } from "../types";
import type { AtlasDestination, AtlasDestinationRequest } from "./types";
import { chunk } from "./types";

export interface PostHogDestinationConfig {
  /** PostHog project API key (`phc_...`). */
  apiKey: string;
  /**
   * Ingestion host. Defaults to `https://us.i.posthog.com`, or
   * `https://eu.i.posthog.com` when the provider-wide `region` is `"eu"`.
   */
  host?: string;
}

const US_HOST = "https://us.i.posthog.com";
const EU_HOST = "https://eu.i.posthog.com";
/** PostHog accepts large batches; the client's queue cap (500) is the real bound. */
const MAX_BATCH = 500;

export function posthogDestination(
  config: PostHogDestinationConfig,
  region: "us" | "eu" = "us"
): AtlasDestination {
  const host = (config.host ?? (region === "eu" ? EU_HOST : US_HOST)).replace(
    /\/+$/,
    ""
  );
  return {
    name: "posthog",
    maxBatchSize: MAX_BATCH,
    buildRequests(batch: AtlasCapturedEvent[]): AtlasDestinationRequest[] {
      return chunk(batch, MAX_BATCH).map((events) => ({
        url: `${host}/batch/`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: config.apiKey,
          historical_migration: false,
          batch: events.map((event) => ({
            event: event.event,
            distinct_id: event.distinct_id,
            timestamp: event.timestamp,
            // Stable per capture: a retried batch dedupes instead of
            // double-counting the user.
            uuid: event.insert_id,
            properties: event.properties,
          })),
        }),
      }));
    },
  };
}
