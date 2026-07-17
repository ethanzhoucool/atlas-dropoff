/**
 * Auto screen tracking for Expo Router.
 *
 * expo-router is an optional peer: it's resolved once with a try/catch
 * require (Metro's optional-dependency pattern), so apps without it never
 * pay for it — <AtlasAutoTrack> just renders nothing.
 */

import { useEffect } from "react";
import { getClient } from "./client";

interface ExpoRouterModule {
  usePathname?: () => string | null;
  useSegments?: () => string[];
}

let expoRouter: ExpoRouterModule | undefined;
try {
  expoRouter =
    typeof require === "function"
      ? (require("expo-router") as ExpoRouterModule)
      : undefined;
} catch {
  expoRouter = undefined;
}

/** True when expo-router is installed (exposes useSegments or usePathname). */
export function isExpoRouterAvailable(): boolean {
  return (
    typeof expoRouter?.useSegments === "function" ||
    typeof expoRouter?.usePathname === "function"
  );
}

/**
 * Canonical screen key from expo-router segments. Segments carry the route
 * *pattern* (`["(tabs)", "product", "[id]"]`), so a dynamic route stays one
 * stable key instead of splintering into one key per parameter value. Group
 * segments — wrapped in parentheses, like `(tabs)` — are dropped, the rest
 * joined with `/`: `["(tabs)", "product", "[id]"]` → `/product/[id]`, and no
 * segments (the root route) → `/`.
 */
function screenKeyFromSegments(segments: readonly string[]): string {
  const parts = segments.filter(
    (segment) => !(segment.startsWith("(") && segment.endsWith(")"))
  );
  return parts.length > 0 ? `/${parts.join("/")}` : "/";
}

/**
 * Emits `atlas_screen` whenever the Expo Router route changes.
 * Mounted automatically by <AtlasProvider> via <AtlasAutoTrack> when
 * expo-router is detected; only call it yourself if you opted out of that.
 *
 * Must be rendered inside the router (any component under app/ qualifies).
 */
export function useAtlasExpoRouterTracking(): void {
  const useSegments = expoRouter?.useSegments;
  const usePathname = expoRouter?.usePathname;
  // expo-router availability is fixed for the app's lifetime, so this guard
  // never changes between renders and the hook order below stays stable.
  if (!useSegments && !usePathname) {
    return;
  }
  // Prefer segments — they yield the route pattern (`/product/[id]`), the
  // stable join key to Atlas nodes. usePathname (concrete paths like
  // `/product/42`) is only a fallback for expo-router versions without
  // useSegments; use `normalizeScreen` to collapse those keys if needed.
  const screen = useSegments
    ? screenKeyFromSegments(useSegments() ?? [])
    : usePathname
      ? usePathname()
      : null;
  useEffect(() => {
    if (screen) {
      // The client dedupes consecutive identical screens.
      getClient()?.trackScreen(screen);
    }
  }, [screen]);
}
