/**
 * <AtlasProvider> — the one-wrap integration surface.
 *
 * Initializes the shared client before children render and mounts
 * auto-tracking. Config is read once on first mount; changing the props
 * afterwards has no effect (the client is a process-wide singleton).
 */

import * as React from "react";
import { initAtlasAnalytics } from "./client";
import {
  isExpoRouterAvailable,
  useAtlasExpoRouterTracking,
} from "./tracking-expo-router";
import type { AtlasAnalyticsConfig } from "./types";

export interface AtlasProviderProps extends AtlasAnalyticsConfig {
  /**
   * Set false to disable built-in auto tracking and call trackScreen()
   * (or the React Navigation helpers) yourself. Default: true.
   */
  autoTrack?: boolean;
  children: React.ReactNode;
}

/** Tracks provider nesting so an accidental inner provider is inert. */
const AtlasMountedContext = React.createContext<boolean>(false);

export function AtlasProvider(props: AtlasProviderProps): React.ReactElement {
  const { children, autoTrack = true, ...config } = props;
  const alreadyMounted = React.useContext(AtlasMountedContext);

  // Lazy state initializer: runs during the first render, so the client
  // exists before any child can emit events. initAtlasAnalytics is
  // idempotent, which also makes StrictMode's double-invoke harmless.
  React.useState(() => initAtlasAnalytics(config));

  if (alreadyMounted && config.debug) {
    console.warn(
      "[atlas-analytics] Nested <AtlasProvider> detected — the inner one is ignored."
    );
  }

  return (
    <AtlasMountedContext.Provider value={true}>
      {autoTrack && !alreadyMounted ? <AtlasAutoTrack debug={config.debug} /> : null}
      {children}
    </AtlasMountedContext.Provider>
  );
}

/**
 * Auto screen tracking. <AtlasProvider> mounts this for you; render it
 * yourself only with <AtlasProvider autoTrack={false}> setups that still
 * want Expo Router tracking somewhere specific in the tree.
 *
 * - Expo Router installed → tracks route changes automatically (keyed by
 *   route pattern, e.g. `/product/[id]`). Wrapped in an error boundary, so a
 *   merely-transitive expo-router install degrades to no auto-tracking
 *   instead of crashing the app.
 * - React Navigation → needs your container ref; renders nothing here.
 *   Use useAtlasNavigationTracking() / onNavigationStateChange() instead.
 * - Neither → renders nothing; call trackScreen() manually.
 */
export function AtlasAutoTrack(props?: {
  /** Log a warning if Expo Router auto-tracking has to disable itself. */
  debug?: boolean;
}): React.ReactElement | null {
  // Availability is fixed at bundle time, so this branch is stable and the
  // hook inside ExpoRouterTracker always runs under the same conditions.
  if (isExpoRouterAvailable()) {
    return <ExpoRouterTrackerBoundary debug={props?.debug} />;
  }
  return null;
}

function ExpoRouterTracker(): null {
  useAtlasExpoRouterTracking();
  return null;
}

interface ExpoRouterTrackerBoundaryProps {
  debug?: boolean;
}

interface ExpoRouterTrackerBoundaryState {
  disabled: boolean;
}

/**
 * Error boundary around the Expo Router hook tracker.
 *
 * expo-router can be merely resolvable (e.g. a transitive dependency of a
 * React Navigation app) without ExpoRoot's navigation context ever being
 * mounted — its hooks then throw. A stray expo-router in node_modules must
 * degrade to "no auto-track", never crash the host app, so this boundary
 * catches the throw, disables itself, and renders nothing from then on.
 */
class ExpoRouterTrackerBoundary extends React.Component<
  ExpoRouterTrackerBoundaryProps,
  ExpoRouterTrackerBoundaryState
> {
  state: ExpoRouterTrackerBoundaryState = { disabled: false };

  static getDerivedStateFromError(): ExpoRouterTrackerBoundaryState {
    return { disabled: true };
  }

  componentDidCatch(error: unknown): void {
    if (this.props.debug) {
      console.warn(
        "[atlas-analytics] Expo Router auto-tracking threw (expo-router is " +
          "installed but its navigation context isn't mounted?) — auto screen " +
          "tracking disabled. Use the React Navigation helpers or trackScreen().",
        error
      );
    }
  }

  render(): React.ReactNode {
    return this.state.disabled ? null : <ExpoRouterTracker />;
  }
}
