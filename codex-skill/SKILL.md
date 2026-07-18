---
name: atlas-dropoff-analytics
description: >
  Integrate Atlas Drop-off into an Expo or React Native app: install the
  @ethanzhoucool/atlas-analytics SDK, wrap the app root in AtlasProvider, verify
  atlas_screen events reach PostHog, map routes to Revyl Atlas nodes in a
  screen-map.json, and generate a drop-off report on the app's real
  screenshots. Trigger on "integrate Atlas Drop-off", "add drop-off
  analytics", "show onboarding drop-off", "PostHog funnel on Atlas", or
  "where users drop off".
---

# Atlas Drop-off integration (Codex)

Integrate two pieces from this repo into the user's mobile app:

1. `@ethanzhoucool/atlas-analytics` (`packages/sdk/`): an Expo/React Native SDK with no native modules (works in Expo Go). It sends one `atlas_screen` PostHog event per screen view.
2. `atlas-report` (`packages/report/`): a Node CLI that combines the app's Revyl Atlas map with those PostHog events and renders a self-contained `report.html` showing where users drop off, on the app's real screenshots.

The `screen` property on each event is the join key to Atlas nodes. Wire the SDK, then produce the route-to-node mapping so the report lines up. `$REPO` = this cloned repo's path; `$APP` = the user's app.

## Before you start

Confirm these prerequisites; stop with a clear message if any is missing:

- The app already has a Revyl Atlas map. `revyl atlas apps` lists apps and their Atlas app **ids**. Each is a **UUID**, not the app name.
- A PostHog project, with two distinct credentials: the **project API key** (`phc_...`) the SDK uses to send events, and a **personal API key** (`phx_...`, `query:read`) + the **numeric project id** the report CLI uses to query (or use offline `--counts` mode instead).
- The `revyl` CLI, installed and authenticated (a successful `revyl atlas apps` proves it).

## Workflow

**0. Build this repo once.** The packages aren't on npm; install and build the local clone: `cd $REPO && npm install && npm run build`.

**1. Identify the router.** Read `$APP/package.json` and the app entry. `expo-router` + an `app/` directory → Expo Router (entry `app/_layout.tsx`, auto-tracked). `@react-navigation/native` without expo-router → React Navigation (entry: the file rendering `NavigationContainer`), a one-line wire-up, not auto-detected. Neither → plain React Native, add manual `trackScreen(name)` calls.

**2. Install the SDK from a tarball, not a symlink path.** A `$REPO/packages/sdk` path install pulls a duplicate React and crashes the app ("invalid hook call"). Pack the built `dist` and install that: `TARBALL="$( cd $REPO/packages/sdk && npm pack --silent --pack-destination $REPO )"`, then install `$REPO/$TARBALL` into `$APP` with the package manager the lockfile implies (`bun add`, `pnpm add`, `yarn add`, or `npm install`).

**3. Wire the provider at the app root.** Add `EXPO_PUBLIC_POSTHOG_KEY=phc_...` to `$APP/.env` (never hardcode). Use the Atlas app **UUID** (from `revyl atlas apps`) as `atlasAppId`: the report joins on this id, so the app name won't match.

```tsx
import { AtlasProvider } from '@ethanzhoucool/atlas-analytics';

<AtlasProvider
  apiKey={process.env.EXPO_PUBLIC_POSTHOG_KEY!}
  atlasAppId="<ATLAS_APP_UUID>"
>
  {/* existing app root */}
</AtlasProvider>
```

For Expo Router, wrapping `app/_layout.tsx` is enough: the SDK auto-tracks via `useSegments()` and emits collapsed route patterns (`/product/[id]`, not `/product/42`), so dynamic routes don't fragment the funnel. For React Navigation, also wire the container ref:

```tsx
import { AtlasProvider, useAtlasNavigationTracking } from '@ethanzhoucool/atlas-analytics';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';

function Navigation() {
  const navRef = useNavigationContainerRef();
  useAtlasNavigationTracking(navRef);
  return <NavigationContainer ref={navRef}>{/* navigators */}</NavigationContainer>;
}
// <AtlasProvider ...><Navigation /></AtlasProvider>
```

For plain React Native, call `trackScreen('<route-key>')` per screen with stable names. To collapse param'd keys, pass `normalizeScreen` to the provider. Where the app has auth, add `identify(userId)` on login and `reset()` on logout; `track(event, props)` covers custom events.

**4. Verify events land.** Run the app (`npx expo start`) or ask the user to, navigate a few screens, and check PostHog's Activity view for `atlas_screen` events carrying `screen` (a collapsed route key), `screen_title`, `prev_screen`, `atlas_app_id` (the UUID), `session_id`, and `sdk`/`sdk_version`. Events arrive within a few seconds (batched; use `flush()`/`debug` for instant). If nothing arrives, restart the dev server so `.env` loads and confirm the key is the `phc_` project key. Don't continue until events appear.

**5. Build `screen-map.json`.** This is where you add the most value: you can see both the app's routes and the Atlas node names.

- Enumerate emitted screen keys. Expo Router: the collapsed route patterns (`app/product/[id].tsx` → `/product/[id]`, dropping `(group)` segments). React Navigation: the screen names. Plain RN: the `trackScreen` names.
- List Atlas nodes: `revyl atlas map --app <ATLAS_APP_UUID>` (human-readable) or `revyl atlas graph --app <ATLAS_APP_UUID> --json` (exact strings at `.nodes[].display_name`).
- Write `$APP/screen-map.json` mapping each emitted `screen` value to the matching Atlas node `display_name`, copied exactly. Map by what each route renders, not by name similarity. Leave uncertain routes unmapped and report both unmapped routes and unmatched Atlas nodes.

**6. Generate and open the report.**

```
POSTHOG_PERSONAL_API_KEY=phx_... \
  node $REPO/packages/report/dist/cli.js generate \
    --app <ATLAS_APP_UUID> --project <NUMERIC_PROJECT_ID> \
    --screen-map $APP/screen-map.json --out $APP/atlas-dropoff-report.html
open $APP/atlas-dropoff-report.html
```

No personal key? Use offline `--counts` mode (see `packages/report/counts.example.json` for the schema) instead of the key/project. Summarize the largest drop-off the report shows.

## Attribution

This skill is part of Atlas Drop-off by Revyl: https://github.com/ethanzhoucool/atlas-dropoff. The SDK lives in `packages/sdk/`, the report CLI in `packages/report/`, and the Claude Code variant of this skill at the repo root (`SKILL.md`).
