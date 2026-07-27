/**
 * Mixpanel destination — POST /track (+ /engage for user properties).
 *
 * Identity uses Simplified ID Merge: anonymous events carry
 * `$device_id` with `distinct_id = "$device:<id>"`, and once the user logs in
 * every event carries `$device_id` AND `$user_id` (with `distinct_id` = the
 * user id). That pairing is what fuses the two into one identity cluster, so
 * pre-login and post-login screens count as the same person in the funnel.
 */

import type { AtlasCapturedEvent } from "../types";
import type {
  AtlasDeliveryVerdict,
  AtlasDestination,
  AtlasDestinationRequest,
} from "./types";
import { chunk, epochMillis, vendorProperties } from "./types";

export interface MixpanelDestinationConfig {
  /** Mixpanel project token. */
  token: string;
  /**
   * Ingestion host. Defaults to `https://api.mixpanel.com`, or
   * `https://api-eu.mixpanel.com` when the provider-wide `region` is `"eu"`.
   */
  host?: string;
}

const US_HOST = "https://api.mixpanel.com";
const EU_HOST = "https://api-eu.mixpanel.com";
/** API limit is 2000 events per request. */
const MAX_BATCH = 500;

function trackPayload(
  event: AtlasCapturedEvent,
  token: string
): Record<string, unknown> | null {
  // Mixpanel needs no explicit identify call — $device_id + $user_id on the
  // events themselves build the identity cluster. User properties are sent
  // separately, to /engage.
  if (event.event === "$identify") return null;

  const properties: Record<string, unknown> = {
    ...vendorProperties(event.properties),
    token,
    time: epochMillis(event),
    $insert_id: event.insert_id,
    distinct_id: event.user_id || `$device:${event.device_id}`,
  };
  if (event.device_id) properties.$device_id = event.device_id;
  if (event.user_id) properties.$user_id = event.user_id;
  return { event: event.event, properties };
}

function engagePayload(
  event: AtlasCapturedEvent,
  token: string
): Record<string, unknown> | null {
  if (event.event !== "$identify") return null;
  const set = event.properties.$set;
  if (typeof set !== "object" || set === null) return null;
  const distinctId = event.user_id || `$device:${event.device_id}`;
  if (!distinctId) return null;
  return { $token: token, $distinct_id: distinctId, $set: set };
}

export function mixpanelDestination(
  config: MixpanelDestinationConfig,
  region: "us" | "eu" = "us"
): AtlasDestination {
  const host = (config.host ?? (region === "eu" ? EU_HOST : US_HOST)).replace(
    /\/+$/,
    ""
  );
  const json = { "Content-Type": "application/json" };
  return {
    name: "mixpanel",
    maxBatchSize: MAX_BATCH,
    // /track answers 200 with a literal `0` when it rejected everything.
    inspectBody: true,
    buildRequests(batch: AtlasCapturedEvent[]): AtlasDestinationRequest[] {
      const requests: AtlasDestinationRequest[] = [];
      for (const events of chunk(batch, MAX_BATCH)) {
        const tracked = events
          .map((e) => trackPayload(e, config.token))
          .filter((e): e is Record<string, unknown> => e !== null);
        if (tracked.length > 0) {
          requests.push({
            url: `${host}/track`,
            headers: json,
            body: JSON.stringify(tracked),
          });
        }
        const profiles = events
          .map((e) => engagePayload(e, config.token))
          .filter((e): e is Record<string, unknown> => e !== null);
        if (profiles.length > 0) {
          requests.push({
            url: `${host}/engage`,
            headers: json,
            body: JSON.stringify(profiles),
          });
        }
      }
      return requests;
    },
    classify(status: number, body: string): AtlasDeliveryVerdict {
      if (status >= 200 && status < 300) {
        // `0` means every event in the payload was rejected (bad token,
        // malformed properties). Retrying the same bytes can't fix that.
        return body.trim() === "0" ? "drop" : "ok";
      }
      if (status === 429 || status >= 500) return "retry";
      return "drop";
    },
  };
}
