/**
 * Auto screen tracking for React Navigation.
 *
 * React Navigation needs a container ref from the app, so unlike Expo Router
 * this can't be fully automatic — it's a one-line wire-up instead. Uses a
 * structural ref type (AtlasNavigationRef), so this module never imports
 * @react-navigation/native.
 */

import { useEffect } from "react";
import { getClient } from "./client";
import type { AtlasNavigationRef } from "./types";

/**
 * Emit an `atlas_screen` event for the ref's current route.
 *
 * Wire it to BOTH `onReady` (first screen) and `onStateChange` (every
 * navigation) on your NavigationContainer — consecutive duplicates are
 * deduped by the client, so double-firing is harmless:
 *
 *   <NavigationContainer
 *     ref={navigationRef}
 *     onReady={() => onNavigationStateChange(navigationRef)}
 *     onStateChange={() => onNavigationStateChange(navigationRef)}
 *   >
 */
export function onNavigationStateChange(navigationRef: AtlasNavigationRef): void {
  const route = navigationRef?.getCurrentRoute?.();
  const name = route?.name;
  if (typeof name === "string" && name.length > 0) {
    getClient()?.trackScreen(name);
  }
}

/**
 * Hook alternative to the onReady/onStateChange wiring: subscribes to the
 * container's "state" events and emits on every route change.
 *
 * Call it with the same ref you pass to <NavigationContainer>. If the
 * container isn't ready when this mounts, the initial screen is picked up on
 * the first "state" event — prefer the onReady/onStateChange wiring if you
 * need the very first screen guaranteed.
 */
export function useAtlasNavigationTracking(navigationRef: AtlasNavigationRef): void {
  useEffect(() => {
    if (!navigationRef) {
      return;
    }
    if (!navigationRef.isReady || navigationRef.isReady()) {
      onNavigationStateChange(navigationRef);
    }
    const unsubscribe = navigationRef.addListener?.("state", () =>
      onNavigationStateChange(navigationRef)
    );
    return unsubscribe;
  }, [navigationRef]);
}
