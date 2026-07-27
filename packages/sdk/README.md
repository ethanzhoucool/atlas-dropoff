# @revyl/atlas-analytics

Tiny drop-in screen analytics for Expo & React Native.

One provider wrap, and your app emits a clean `atlas_screen` event on every
screen change, shaped so the Atlas Drop-off report tool can reconstruct your
funnel and paint drop-off onto your app's real screenshots from
[Revyl Atlas](https://revyl.com).

- **Your analytics vendor.** PostHog, Amplitude, Mixpanel, or a custom
  transport — one config line each, and you can send to several at once.
- **Zero native modules.** Pure TypeScript. Transport is a plain `fetch` POST:
  no vendor SDK, no pods, no config plugins.
- **Works in Expo Go.** Nothing to link, nothing to rebuild.
- **Auto screen tracking.** Expo Router is detected and tracked automatically;
  React Navigation is a one-line wire-up.
- **Graceful everywhere.** Async-storage is optional, delivery never throws,
  offline events are retried, and duplicate screens are deduped for you.

## Install

```sh
npx expo install @revyl/atlas-analytics @react-native-async-storage/async-storage
```

or with npm/yarn:

```sh
npm install @revyl/atlas-analytics @react-native-async-storage/async-storage
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
import { AtlasProvider } from "@revyl/atlas-analytics";

export default function RootLayout() {
  return (
    <AtlasProvider
      posthog={{ apiKey: "phc_your_key" }}
      atlasAppId="your-atlas-app-id"
    >
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
import { AtlasProvider, onNavigationStateChange } from "@revyl/atlas-analytics";

export default function App() {
  const navigationRef = useNavigationContainerRef();
  return (
    <AtlasProvider posthog={{ apiKey: "phc_your_key" }} atlasAppId="your-atlas-app-id">
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

## Pick your analytics vendor

```tsx
// PostHog
<AtlasProvider posthog={{ apiKey: "phc_..." }} atlasAppId="..." />

// Amplitude
<AtlasProvider amplitude={{ apiKey: "..." }} atlasAppId="..." />

// Mixpanel
<AtlasProvider mixpanel={{ token: "..." }} atlasAppId="..." />

// Several at once — useful while migrating between vendors. Each destination
// retries independently, so one being down never blocks the others.
<AtlasProvider
  posthog={{ apiKey: "phc_..." }}
  amplitude={{ apiKey: "..." }}
  atlasAppId="..."
/>

// EU data residency for every destination that didn't set its own host
<AtlasProvider mixpanel={{ token: "..." }} region="eu" atlasAppId="..." />
```

`apiKey` / `host` at the top level are the legacy PostHog spelling and still
work; they're ignored when `posthog={{ … }}` is given.

### Anything else

```tsx
import { AtlasProvider, customDestination } from "@revyl/atlas-analytics";

<AtlasProvider
  atlasAppId="..."
  destinations={[
    customDestination({
      name: "warehouse",
      async send(batch) {
        // batch: canonical events — { event, distinct_id, device_id, user_id,
        // insert_id, timestamp, session_started_at, properties }
        await fetch("https://collector.example.com/events", {
          method: "POST",
          body: JSON.stringify(batch),
        });
        // Throw (or return false) to have the batch retried on the next flush.
      },
    }),
  ]}
/>;
```

Batching, dedupe ids, identity stamping and retries stay with the SDK; the
custom destination only has to deliver.

### No router at all?

The provider still works. Call `trackScreen()` yourself:

```ts
import { trackScreen } from "@revyl/atlas-analytics";

trackScreen("Paywall", { title: "Paywall" });
```

## Identify users

```ts
import { identify, reset } from "@revyl/atlas-analytics";

// After login: switches to your user id and merges the anonymous history
// into that user, in each vendor's own dialect (PostHog $identify with
// $anon_distinct_id; Amplitude and Mixpanel device_id + user_id pairing).
identify("user_123", { plan: "pro" });

// After logout: back to the anonymous install id, fresh session.
reset();
```

Until you call `identify()`, events use a stable anonymous install id that is
generated once and persisted (when async-storage is available).

## Custom events

```ts
import { track, flush } from "@revyl/atlas-analytics";

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
<AtlasProvider atlasAppId posthog? amplitude? mixpanel? destinations? region?
               debug? flushAt? flushInterval? requestTimeout?
               normalizeScreen? autoTrack?>

// Destinations (for `destinations: [...]`)
posthogDestination({ apiKey, host? })
amplitudeDestination({ apiKey, host?, minIdLength? })
mixpanelDestination({ token, host? })
customDestination({ name, send, maxBatchSize? })

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
| `atlasAppId`    | `string`  | (required)                  | Revyl Atlas app id; the join key to your Atlas map. |
| `posthog`       | `{ apiKey, host? }` | —                 | PostHog project API key (`phc_...`).               |
| `amplitude`     | `{ apiKey, host?, minIdLength? }` | —   | Amplitude project API key. `minIdLength` defaults to 1 so short user ids aren't rejected. |
| `mixpanel`      | `{ token, host? }` | —                  | Mixpanel project token.                            |
| `destinations`  | `AtlasDestination[]` | `[]`             | Extra destinations, e.g. `customDestination(...)`. Combined with the three above. |
| `region`        | `"us" \| "eu"` | `"us"`                 | Data region for any destination without its own `host`. |
| `apiKey`        | `string`  | —                           | Legacy PostHog key; same as `posthog: { apiKey }`. |
| `host`          | `string`  | —                           | Legacy PostHog host; same as `posthog: { host }`.  |
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
| `sdk_version`  | `string`         | Always `"0.2.0"` for this release.                                                        |
| `$screen_name` | `string`         | Mirrors the screen key as a plain property, handy for PostHog filters. (PostHog's native "Screens" UI keys off events literally named `$screen`, which this SDK does not emit.) |

On the wire, each destination maps that same event into its own envelope.
PostHog (`POST ${host}/batch/`):

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
        "sdk_version": "0.2.0"
      }
    }
  ]
}
```

Amplitude (`POST https://api2.amplitude.com/2/httpapi`) receives the same
properties as `event_properties`, with `device_id` (install id) and `user_id`
(after `identify()`) side by side, a numeric `session_id`, and an `insert_id`
for dedupe. User properties go to the dedicated form-encoded
`POST /identify` endpoint rather than riding along as an event. Mixpanel (`POST https://api.mixpanel.com/track`) receives them
with `$device_id`/`$user_id` and a `$device:`-prefixed `distinct_id` while
anonymous. The `$`-prefixed PostHog properties (`$screen_name`, `$set`,
`$anon_distinct_id`) are stripped from the other two.

`distinct_id` is a stable per-install UUID until `identify()` swaps in your
user id. On PostHog, `identify()` also emits a `$identify` event (with
`$anon_distinct_id`) so the anonymous history merges into the user; Amplitude
and Mixpanel merge from the device+user id pairing instead, and user
properties go to their `/identify` and `/engage` endpoints respectively.

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
- **Destinations retry independently.** A batch PostHog accepted and Amplitude
  500'd is retried for Amplitude only — no duplicate delivery to the vendor
  that already took it. Every event carries a stable `insert_id`
  (`uuid` on PostHog, `insert_id` on Amplitude, `$insert_id` on Mixpanel), so
  even a partially-delivered retry dedupes rather than double-counting.
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
