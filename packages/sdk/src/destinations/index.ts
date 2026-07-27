/**
 * Destination registry: turn the provider config into a list of destinations.
 */

import type { AtlasAnalyticsConfig } from "../types";
import { amplitudeDestination } from "./amplitude";
import { mixpanelDestination } from "./mixpanel";
import { posthogDestination } from "./posthog";
import type { AtlasDestination } from "./types";

export { amplitudeDestination } from "./amplitude";
export type { AmplitudeDestinationConfig } from "./amplitude";
export { customDestination } from "./custom";
export type { CustomDestinationConfig } from "./custom";
export { mixpanelDestination } from "./mixpanel";
export type { MixpanelDestinationConfig } from "./mixpanel";
export { posthogDestination } from "./posthog";
export type { PostHogDestinationConfig } from "./posthog";
export { defaultClassify } from "./types";
export type {
  AtlasDeliveryVerdict,
  AtlasDestination,
  AtlasDestinationRequest,
} from "./types";

/**
 * Build the destination list from config, in a fixed order (posthog,
 * amplitude, mixpanel, then any explicit `destinations`). `apiKey`/`host` at
 * the top level are the legacy PostHog spelling and are ignored when
 * `posthog: { … }` is given.
 */
export function resolveDestinations(
  config: AtlasAnalyticsConfig
): AtlasDestination[] {
  const region = config.region ?? "us";
  const out: AtlasDestination[] = [];

  const posthog = config.posthog ?? (config.apiKey ? { apiKey: config.apiKey, host: config.host } : undefined);
  if (posthog?.apiKey) out.push(posthogDestination(posthog, region));
  if (config.amplitude?.apiKey) out.push(amplitudeDestination(config.amplitude, region));
  if (config.mixpanel?.token) out.push(mixpanelDestination(config.mixpanel, region));
  if (config.destinations) out.push(...config.destinations);

  return out;
}
