---
name: atlas-dropoff
description: >
  Integrate Atlas Drop-off into an Expo or React Native app end-to-end: install the
  @revyl/atlas-analytics SDK, wrap the app root in AtlasProvider, verify atlas_screen
  events reach PostHog, build a screen-map.json against the app's Revyl Atlas graph,
  and generate a drop-off report painted on the app's real screenshots. Use when the
  user says "integrate Atlas Drop-off", "add drop-off analytics", "show onboarding
  drop-off", "show checkout drop-off", "PostHog funnel on Atlas", "where users drop
  off", "set up atlas-analytics", "wire up AtlasProvider", or "generate the drop-off
  report".
---

# Atlas Drop-off integration

You are integrating Atlas Drop-off into the user's mobile app. Two pieces ship in this repo:

- `@revyl/atlas-analytics` (`packages/sdk/`): a tiny Expo/React Native SDK. No native modules, works in Expo Go. It emits one `atlas_screen` PostHog event per screen view.
- `atlas-report` (`packages/report/`): a Node CLI that fetches the app's Revyl Atlas map, queries PostHog for `atlas_screen` events, and renders a self-contained `report.html` showing drop-off on the app's real screenshots.

The join key is the `screen` property on each event. Your job is to wire the SDK, then map the app's route keys to Atlas node names so the report can paint numbers onto the right screenshots.

`$REPO` below = the path to THIS cloned repo (the folder containing this SKILL.md). `$APP` = the user's mobile app project.

## Prerequisites (check first; stop with a clear message if any is missing)

- An existing Revyl Atlas map for the app. Run `revyl atlas apps` and note the Atlas **app id**, a **UUID** (e.g. `cda16afc-2b9c-4042-a0c2-d863dc3c9ec6`), not the app name. If the app isn't listed, the user needs an Atlas map first (Atlas is built by Revyl's vision-based engine exploring the app on cloud devices).
- A PostHog project. Two different credentials are involved; don't confuse them:
  - the **project API key** (`phc_...`): the *ingest* key the SDK uses to send events (safe to ship in the app bundle).
  - a **personal API key** (`phx_...`, scope `query:read`) plus the **numeric project id** (the number in the PostHog project URL): used by the report CLI to *query* events. (Or skip these with offline `--counts` mode, Step 6.)
- The `revyl` CLI, installed and authenticated (`revyl atlas apps` succeeding proves both).

## Step 0: Build this repo once

The packages aren't published to npm, so you install them from this local clone. Build them first:

```
cd $REPO && npm install && npm run build
```

This emits `packages/sdk/dist` and `packages/report/dist`.

## Step 1: Detect the app's stack

Read `$APP/package.json` and the app entry to classify the router:

- `expo-router` in dependencies, with an `app/` directory → **Expo Router** (entry: `app/_layout.tsx`). Auto-tracked.
- `@react-navigation/native`, no expo-router → **React Navigation** (entry: wherever `NavigationContainer` is rendered, usually `App.tsx`). One-line wire-up, NOT auto-detected.
- Neither → **plain React Native**: no auto-tracking; call `trackScreen(name)` manually at screen transitions.

## Step 2: Install the SDK (from this local clone)

Detect the package manager from the app's lockfile and install `@revyl/atlas-analytics` **by path**:

| Lockfile | Command (run in `$APP`) |
| --- | --- |
| `bun.lockb` / `bun.lock` | `bun add $REPO/packages/sdk` |
| `pnpm-lock.yaml` | `pnpm add $REPO/packages/sdk` |
| `yarn.lock` | `yarn add $REPO/packages/sdk` |
| `package-lock.json` / none | `npm install $REPO/packages/sdk` |

## Step 3: Wire AtlasProvider at the app root

Put the PostHog **project** key in env (never hardcode). Add to `$APP/.env`:

```
EXPO_PUBLIC_POSTHOG_KEY=phc_...
```

Use the Atlas app **UUID** (from `revyl atlas apps`) as `atlasAppId`. The report joins on this exact id, so if you pass the app *name* instead, events won't match and the report is empty.

**Expo Router** (`app/_layout.tsx`): wrap the root layout. That's the whole wiring: the SDK auto-tracks via `useSegments()`, which emits **collapsed route patterns** (`/product/[id]`, not `/product/42`), so dynamic routes don't fragment the funnel.

```tsx
import { AtlasProvider } from '@revyl/atlas-analytics';

export default function RootLayout() {
  return (
    <AtlasProvider
      apiKey={process.env.EXPO_PUBLIC_POSTHOG_KEY!}
      atlasAppId="<ATLAS_APP_UUID>"
    >
      <Stack />  {/* existing layout content unchanged */}
    </AtlasProvider>
  );
}
```

**React Navigation** is NOT auto-detected. Wire the navigation ref with `useAtlasNavigationTracking`:

```tsx
import { AtlasProvider, useAtlasNavigationTracking } from '@revyl/atlas-analytics';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';

function Navigation() {
  const navRef = useNavigationContainerRef();
  useAtlasNavigationTracking(navRef); // emits atlas_screen on each route change
  return (
    <NavigationContainer ref={navRef}>
      {/* your navigators, unchanged */}
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <AtlasProvider apiKey={process.env.EXPO_PUBLIC_POSTHOG_KEY!} atlasAppId="<ATLAS_APP_UUID>">
      <Navigation />
    </AtlasProvider>
  );
}
```

**Plain React Native**: call `trackScreen('<route-key>')` from each screen (e.g. in a mount effect) with stable, canonical keys.

If a route carries params that you want collapsed (e.g. React Navigation `Product/123`), pass `normalizeScreen` to the provider: `normalizeScreen={(s) => s.replace(/\/\d+/g, '/[id]')}`. It runs on every screen key (auto and manual).

If the app has auth, wire identity where login/logout happen: `identify(userId)` on login, `reset()` on logout. Custom events go through `track(event, props)`.

## Step 4: Verify events fire

Run the app (`npx expo start`, or the app's run command) and navigate through 3-4 screens. Check PostHog's Activity (live events) view, filtered to event `atlas_screen`. Each event should carry `screen` (a collapsed route key like `/product/[id]`), `screen_title`, `prev_screen`, `atlas_app_id` (matching the UUID you wired), `session_id`, and `sdk`/`sdk_version`.

Events land within a few seconds (the SDK batches; default flush is 5s). For instant confirmation during setup, pass `debug` to the provider and/or call `flush()`. Don't proceed until events are visibly landing. If nothing arrives: restart the dev server after editing `.env`, and confirm the key is the PostHog **project** key (`phc_`).

## Step 5: Build screen-map.json (highest-value step)

The report joins PostHog `screen` values to Atlas nodes. You have both sides in context, so produce the mapping yourself:

1. List the app's emitted screen keys. Expo Router: they are the **collapsed route patterns**. Enumerate files under `app/` and keep the bracket form (`app/product/[id].tsx` → `/product/[id]`), dropping group segments like `(tabs)`. React Navigation: the screen names. Plain RN: the names you passed to `trackScreen`.
2. List the real Atlas node names. Use the human-readable summary to eyeball them, then the JSON for exact strings:

```
revyl atlas map --app <ATLAS_APP_UUID>          # human-readable node list
revyl atlas graph --app <ATLAS_APP_UUID> --json # exact names at .nodes[].display_name
```

3. Write `$APP/screen-map.json` mapping each emitted `screen` value to the Atlas node `display_name`, copied exactly:

```json
{
  "/": "storefront_home_feed",
  "/collection": "product_listing_collection",
  "/product/[id]": "product_detail",
  "/checkout": "checkout_form"
}
```

Match by meaning (read what each route renders), not string similarity. Leave a route unmapped rather than guessing wrong, and tell the user which routes had no Atlas node and which Atlas nodes had no route.

## Step 6: Generate the report

Live query (needs the personal key + numeric project id from Prerequisites):

```
POSTHOG_PERSONAL_API_KEY=phx_... \
  node $REPO/packages/report/dist/cli.js generate \
    --app <ATLAS_APP_UUID> --project <NUMERIC_PROJECT_ID> \
    --screen-map $APP/screen-map.json --out $APP/atlas-dropoff-report.html
```

No personal key handy? Run offline: query the per-screen and per-transition counts yourself (any PostHog access works) into a `--counts` JSON (`node $REPO/packages/report/dist/cli.js --help` and `packages/report/counts.example.json` show the schema), then pass `--counts counts.json` instead of the key/project.

Open the result:

```
open $APP/atlas-dropoff-report.html
```

The report is a single self-contained HTML file: the app's Atlas screenshots with real user counts and drop-off percentages on each screen transition. Point the user at the biggest drop-off edge in the data.
