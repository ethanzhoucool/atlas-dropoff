/**
 * @revyl/atlas-analytics — tiny drop-in screen analytics for Expo & React
 * Native, shaped for Revyl Atlas drop-off reports.
 *
 * Typical integration is just:
 *
 *   <AtlasProvider apiKey="phc_..." atlasAppId="...">
 *     <App />
 *   </AtlasProvider>
 */

import { getClient } from "./client";
import type { AtlasEventProperties, TrackScreenOptions } from "./types";

export { initAtlasAnalytics } from "./client";
export type { AtlasClient } from "./client";

export { AtlasProvider, AtlasAutoTrack } from "./provider";
export type { AtlasProviderProps } from "./provider";

export {
  isExpoRouterAvailable,
  useAtlasExpoRouterTracking,
} from "./tracking-expo-router";
export {
  onNavigationStateChange,
  useAtlasNavigationTracking,
} from "./tracking-react-navigation";

export type {
  AtlasAnalyticsConfig,
  AtlasCapturedEvent,
  AtlasEventProperties,
  AtlasNavigationRef,
  AtlasScreenEventProperties,
  TrackScreenOptions,
} from "./types";

// ---------------------------------------------------------------------------
// Convenience functions over the shared client. All of them are safe no-ops
// (with a one-time console warning) if the SDK hasn't been initialized.
// ---------------------------------------------------------------------------

/**
 * Manually record a screen view (`atlas_screen`). Auto tracking covers Expo
 * Router / React Navigation; use this for custom navigation or modals.
 * Consecutive duplicates are deduped.
 */
export function trackScreen(screen: string, options?: TrackScreenOptions): void {
  getClient()?.trackScreen(screen, options);
}

/** Capture a custom event, tagged with atlas_app_id / session_id / sdk. */
export function track(event: string, properties?: AtlasEventProperties): void {
  getClient()?.track(event, properties);
}

/** Attach a real user id (e.g. after login). Merges the anonymous history. */
export function identify(userId: string, props?: AtlasEventProperties): void {
  getClient()?.identify(userId, props);
}

/** Logout: back to the anonymous install id, with a fresh session. */
export function reset(): void {
  getClient()?.reset();
}

/** Force-send everything queued right now. */
export function flush(): Promise<void> {
  return getClient()?.flush() ?? Promise.resolve();
}
