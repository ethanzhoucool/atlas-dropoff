# @ethanzhoucool/atlas-analytics

Tiny drop-in screen analytics for Expo & React Native.

One provider wrap, and your app emits a clean `atlas_screen` event on every
screen change, shaped so the Atlas Drop-off report tool can reconstruct your
funnel and paint drop-off onto your app's real screenshots from
[Revyl Atlas](https://revyl.com).

- **Zero native modules.** Pure TypeScript. Transport is a plain `fetch` POST
  to PostHog: no `posthog-react-native`, no pods, no config plugins.
- **Works in Expo Go.** Nothing to link, nothing to rebuild.
- **Auto screen tracking.** Expo Router is detected and tracked automatically;
  React Navigation is a one-line wire-up.
- **Graceful everywhere.** Async-storage is optional, delivery never throws,
  offline events are retried, and duplicate screens are deduped for you.

## Install

```sh
npx expo install @ethanzhoucool/atlas-analytics @react-native-async-storage/async-storage
```

or with npm/yarn:

```sh
npm install @ethanzhoucool/atlas-analytics @react-native-async-storage/async-storage
```

`@react-native-async-storage/async-storage` is optional but recommended: it's
what keeps the anonymous `distinct_id` stable across app launches. Without it
the SDK still works and falls back to in-memory ids (which reset per launch).

## Quickstart: Expo Router

Wrap your root layout. That's the whole integration: every route change
emits an `atlas_screen` event automatically. Screens are keyed by their
**route pattern** (built from `useSegments()`), so `/product/42` and
`/product/7` both track as `/product/[id]` and join to a single Atlas node
(group segments like `(tabs)` are dropped):

```tsx
// app/_layout.tsx
import { Stack } from "expo-router";
import { AtlasProvider } from "@ethanzhoucool/atlas-analytics";

export default function RootLayout() {
  return (
    <AtlasProvider apiKey="phc_your_key" atlasAppId="your-atlas-app-id">
      <Stack />
    </AtlasProvider>
  );
}
```

## Quickstart: React Navigation

React Navigation needs your container ref (the SDK can't reach it otherwise),
so it's one extra line on the container:

```tsx
import { NavigationContainer, useNavigationContainerRef } from "@react-navigation/native";
import { AtlasProvider, onNavigationStateChange } from "@ethanzhoucool/atlas-analytics";

export default function App() {
  const navigationRef = useNavigationContainerRef();
  return (
    <AtlasProvider apiKey="phc_your_key" atlasAppId="your-atlas-app-id">
      <NavigationContainer
        ref={navigationRef}
        onReady={() => onNavigationStateChange(navigationRef)}
        onStateChange={() => onNavigationStateChange(navigationRef)}
      >
        {/* your navigators */}
      </NavigationContainer>
    </AtlasProvider>
  );
}
```

Wiring both `onReady` and `onStateChange` is intentional: `onReady` captures
the first screen, `onStateChange` captures every navigation, and consecutive
duplicates are deduped by the SDK, so double-firing is harmless.

Prefer hooks? `useAtlasNavigationTracking(navigationRef)` subscribes to the
container's `"state"` events instead.

### No router at all?

The provider still works. Call `trackScreen()` yourself:

```ts
import { trackScreen } from "@ethanzhoucool/atlas-analytics";

trackScreen("Paywall", { title: "Paywall" });
```

## Identify users

```ts
import { identify, reset } from "@ethanzhoucool/atlas-analytics";

// After login: switches distinct_id to your user id and merges the
// anonymous history into that user (via PostHog $identify).
identify("user_123", { plan: "pro" });

// After logout: back to the anonymous install id, fresh session.
reset();
```

Until you call `identify()`, events use a stable anonymous install id that is
generated once and persisted (when async-storage is available).

## Custom events

```ts
import { track, flush } from "@ethanzhoucool/atlas-analytics";

track("add_to_cart", { sku: "X1", qty: 2 });

// Optional: force-send everything queued right now (e.g. before logout).
await flush();
```

Custom events are tagged with the same `atlas_app_id` / `session_id` / `sdk`
properties so they slot into the same funnel analysis.

## API

```ts
// Setup (pick one; <AtlasProvider> calls initAtlasAnalytics for you)
initAtlasAnalytics(config: AtlasAnalyticsConfig): AtlasClient
<AtlasProvider apiKey atlasAppId host? debug? flushAt? flushInterval?
               requestTimeout? normalizeScreen? autoTrack?>

// Screens & events
trackScreen(screen: string, options?: { title?: string; screenKeyOverride?: string }): void
track(event: string, properties?: Record<string, unknown>): void

// Identity
identify(userId: string, props?: Record<string, unknown>): void
reset(): void

// Delivery
flush(): Promise<void>
// On the AtlasClient instance (returned by initAtlasAnalytics):
client.shutdown(): Promise<void>   // final flush, then stops the flush timer +
                                   // AppState listener. For tests / hot-reload
                                   // environments; apps normally never call it.

// Auto-tracking helpers
<AtlasAutoTrack debug? />                           // mounted by the provider; manual escape hatch
onNavigationStateChange(navigationRef): void        // React Navigation, callback style
useAtlasNavigationTracking(navigationRef): void     // React Navigation, hook style
useAtlasExpoRouterTracking(): void                  // Expo Router (used by AtlasAutoTrack)
isExpoRouterAvailable(): boolean
```

### Config

| Option          | Type      | Default                     | Notes                                              |
| --------------- | --------- | --------------------------- | -------------------------------------------------- |
| `apiKey`        | `string`  | (required)                  | PostHog project API key (`phc_...`).               |
| `atlasAppId`    | `string`  | (required)                  | Revyl Atlas app id; the join key to your Atlas map. |
| `host`          | `string`  | `https://us.i.posthog.com`  | Use `https://eu.i.posthog.com` for EU Cloud.       |
| `debug`         | `boolean` | `false`                     | Console logging + delivery warnings.               |
| `flushAt`       | `number`  | `20`                        | Flush when this many events are queued.            |
| `flushInterval` | `number`  | `5000` (ms)                 | Periodic flush interval (min 1000).                |
| `requestTimeout` | `number` | `10000` (ms)                | Abort a delivery request after this long; the batch is requeued like any transient network failure. |
| `normalizeScreen` | `(screen: string) => string` | identity | Rewrite screen keys before dedupe/capture: collapse dynamic screens into one canonical key (e.g. `/users/123` → `/users/[id]`). Applies to auto, manual, and React Navigation paths alike, after `screenKeyOverride`. |
| `autoTrack`     | `boolean` | `true`                      | Provider-only. Disable built-in auto tracking.     |

## Event schema

One `atlas_screen` event fires per screen focus / navigation change.
Consecutive identical screens are deduped (never the same screen twice in a
row). Every event carries:

| Property       | Type             | Description                                                                              |
| -------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `screen`       | `string`         | Canonical screen key: route name (React Navigation) or route pattern (Expo Router, e.g. `/product/[id]`). **Join key to Atlas nodes.** |
| `screen_title` | `string?`        | Human-readable label, when available.                                                    |
| `prev_screen`  | `string \| null` | Previous screen key, for edge/transition attribution. `null` on a session's first screen. |
| `atlas_app_id` | `string`         | Revyl Atlas app id, from config.                                                          |
| `session_id`   | `string`         | Per-app-launch id (rotates on `reset()`).                                                 |
| `sdk`          | `string`         | Always `"atlas-analytics-rn"`.                                                            |
| `sdk_version`  | `string`         | Always `"0.1.0"` for this release.                                                        |
| `$screen_name` | `string`         | Mirrors the screen key as a plain property, handy for PostHog filters. (PostHog's native "Screens" UI keys off events literally named `$screen`, which this SDK does not emit.) |

On the wire, events are batched and POSTed to `${host}/batch/`:

```json
{
  "api_key": "phc_your_key",
  "historical_migration": false,
  "batch": [
    {
      "event": "atlas_screen",
      "distinct_id": "8fe8520c-166f-4d9b-9de6-fb08c7bfce13",
      "timestamp": "2026-07-16T18:24:31.512Z",
      "properties": {
        "screen": "/checkout",
        "prev_screen": "/cart",
        "$screen_name": "/checkout",
        "screen_title": "Checkout",
        "atlas_app_id": "b54f8035-your-atlas-app-id",
        "session_id": "d6df4601-1a40-4f7f-a906-5cf327734ec6",
        "sdk": "atlas-analytics-rn",
        "sdk_version": "0.1.0"
      }
    }
  ]
}
```

`distinct_id` is a stable per-install UUID until `identify()` swaps in your
user id. `identify()` also emits a PostHog `$identify` event (with
`$anon_distinct_id`) so the anonymous history merges into the user.

## How delivery works

- Events queue in memory and flush on a 5s interval, when 20 events are
  queued, when the app goes to the `background` state, or on an explicit
  `flush()`. (iOS's transient `inactive` state, e.g. app-switcher peek or
  Control Center, does not trigger a flush.)
- **The queue is in-memory only.** The background flush is best effort:
  events still queued when the app is hard-killed or crashes are lost.
- Each delivery request is aborted after `requestTimeout` (default 10s) and
  the batch requeued, so a stalled connection can't wedge delivery.
- The network path never throws into your app. Transient failures
  (network errors, timeouts, 429, 5xx) requeue the batch for the next flush;
  permanent ones (other 4xx) drop it. With `debug: true` you'll see a
  `console.warn`.
- The queue is capped at 500 events, dropping oldest first, so a long offline
  session can't grow memory unbounded.

## Notes

- **Expo Go:** fully supported. There's no native code anywhere in this
  package.
- **Dynamic screens:** Expo Router auto-tracking already keys screens by
  route pattern (`/product/[id]`), so dynamic routes collapse automatically.
  For React Navigation route params or custom keys, use the `normalizeScreen`
  config option (applies everywhere, including auto tracking) or a per-call
  `screenKeyOverride` to collapse e.g. `/users/123` → `/users/[id]`.
- **Both routers installed?** Expo Router wins auto-detection. If you're on
  plain React Navigation with expo-router coincidentally in your
  node_modules, its hooks throw outside a router. The SDK catches that in an
  error boundary and disables auto-tracking instead of crashing (with
  `debug: true` it logs a warning). Pass `autoTrack={false}` and use the
  React Navigation helpers to track screens.
- **Optional deps & Metro:** the SDK resolves `expo-router` and
  `async-storage` with literal `require()` calls inside `try/catch` (Metro's
  optional-dependency pattern), so apps without them still bundle and run.
