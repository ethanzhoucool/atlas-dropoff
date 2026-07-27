/**
 * Amplitude destination — POST /2/httpapi (HTTP V2).
 *
 * Identity: Amplitude has no `$identify`-with-anon-id handshake. Sending
 * `device_id` (the anonymous install id) and `user_id` (once known) on the
 * SAME event is what merges the pre-login history into the user, so every
 * event carries both. The client's `$identify` event therefore only matters
 * for the user properties it carries, and those go to Amplitude's dedicated
 * /identify endpoint rather than riding along as an event.
 */

import type { AtlasCapturedEvent } from "../types";
import type {
  AtlasDeliveryVerdict,
  AtlasDestination,
  AtlasDestinationRequest,
} from "./types";
import { chunk, epochMillis, vendorProperties } from "./types";

export interface AmplitudeDestinationConfig {
  /** Amplitude project API key. */
  apiKey: string;
  /**
   * Ingestion host. Defaults to `https://api2.amplitude.com`, or
   * `https://api.eu.amplitude.com` when the provider-wide `region` is `"eu"`.
   */
  host?: string;
  /**
   * Amplitude rejects user/device ids shorter than 5 characters unless this is
   * lowered. The SDK's install ids are UUIDs, but app-supplied user ids can be
   * short (`"7"`), so the default is 1. Raise it to Amplitude's default of 5
   * to have short ids rejected instead of ingested.
   */
  minIdLength?: number;
}

const US_HOST = "https://api2.amplitude.com";
const EU_HOST = "https://api.eu.amplitude.com";
/** API limit is 2000 events / 1MB per request; stay well under both. */
const MAX_BATCH = 500;

interface AmplitudeEvent {
  event_type: string;
  time: number;
  insert_id: string;
  user_id?: string;
  device_id?: string;
  session_id?: number;
  event_properties?: Record<string, unknown>;
  user_properties?: Record<string, unknown>;
}

function toAmplitudeEvent(event: AtlasCapturedEvent): AmplitudeEvent | null {
  // Identity merging is implicit (device_id + user_id on each event), and
  // user properties go to /identify, so the SDK's $identify has nothing to
  // contribute to the event stream.
  if (event.event === "$identify") return null;

  const out: AmplitudeEvent = {
    event_type: event.event,
    time: epochMillis(event),
    insert_id: event.insert_id,
    event_properties: vendorProperties(event.properties),
  };
  if (event.user_id) out.user_id = event.user_id;
  if (event.device_id) out.device_id = event.device_id;
  // Amplitude sessions are numeric (start time in ms); the SDK's string
  // session id still rides along in event_properties as `session_id`.
  if (event.session_started_at) out.session_id = event.session_started_at;
  return out;
}

/** One `identification` entry for the /identify endpoint, or null. */
function toIdentification(
  event: AtlasCapturedEvent
): Record<string, unknown> | null {
  if (event.event !== "$identify") return null;
  const set = event.properties.$set;
  if (typeof set !== "object" || set === null) return null;
  const out: Record<string, unknown> = { user_properties: { $set: set } };
  if (event.user_id) out.user_id = event.user_id;
  if (event.device_id) out.device_id = event.device_id;
  return out;
}

export function amplitudeDestination(
  config: AmplitudeDestinationConfig,
  region: "us" | "eu" = "us"
): AtlasDestination {
  const host = (config.host ?? (region === "eu" ? EU_HOST : US_HOST)).replace(
    /\/+$/,
    ""
  );
  return {
    name: "amplitude",
    maxBatchSize: MAX_BATCH,
    buildRequests(batch: AtlasCapturedEvent[]): AtlasDestinationRequest[] {
      const requests: AtlasDestinationRequest[] = [];
      for (const events of chunk(batch, MAX_BATCH)) {
        const mapped = events
          .map(toAmplitudeEvent)
          .filter((e): e is AmplitudeEvent => e !== null);
        if (mapped.length > 0) {
          requests.push({
            url: `${host}/2/httpapi`,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: config.apiKey,
              options: { min_id_length: config.minIdLength ?? 1 },
              events: mapped,
            }),
          });
        }
        const identifications = events
          .map(toIdentification)
          .filter((e): e is Record<string, unknown> => e !== null);
        if (identifications.length > 0) {
          // The Identify API is form-encoded, not JSON — the one endpoint here
          // that isn't.
          requests.push({
            url: `${host}/identify`,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body:
              `api_key=${encodeURIComponent(config.apiKey)}` +
              `&identification=${encodeURIComponent(JSON.stringify(identifications))}`,
          });
        }
      }
      return requests;
    },
    classify(status: number): AtlasDeliveryVerdict {
      if (status >= 200 && status < 300) return "ok";
      // 413 = payload too large. The same bytes would fail forever, and the
      // client already chunks, so this is permanent rather than transient.
      if (status === 413) return "drop";
      if (status === 429 || status >= 500) return "retry";
      return "drop";
    },
  };
}
