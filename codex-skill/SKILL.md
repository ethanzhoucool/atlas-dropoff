---
name: atlas-dropoff-analytics
description: >
  Integrate Atlas Drop-off into an Expo or React Native app: install the
  @revyl/atlas-analytics SDK, wrap the app root in AtlasProvider pointed at the
  app's analytics vendor (PostHog, Amplitude, or Mixpanel), verify atlas_screen
  events land, map routes to Revyl Atlas nodes in a screen-map.json, and
  generate a drop-off report on the app's real screenshots. Trigger on
  "integrate Atlas Drop-off", "add drop-off analytics", "show onboarding
  drop-off", "PostHog/Amplitude/Mixpanel funnel on Atlas", or "where users
  drop off".
---

# Atlas Drop-off integration (Codex)

Integrate two pieces from this repo into the user's mobile app:

1. `@revyl/atlas-analytics` (`packages/sdk/`): an Expo/React Native SDK with no native modules (works in Expo Go). It sends one `atlas_screen` event per screen view to PostHog, Amplitude, Mixpanel, or a custom transport.
2. `atlas-report` (`packages/report/`): a Node CLI that combines the app's Revyl Atlas map with those events and renders a self-contained `report.html` showing where users drop off, on the app's real screenshots.

The `screen` property on each event is the join key to Atlas nodes. Wire the SDK, then produce the route-to-node mapping so the report lines up. `$REPO` = this cloned repo's path; `$APP` = the user's app.

## Before you start

Confirm these prerequisites; stop with a clear message if any is missing:

- The app already has a Revyl Atlas map. `revyl atlas apps` lists apps and their Atlas app **ids**. Each is a **UUID**, not the app name.
- An analytics project. Use whichever vendor the app already has — grep `$APP/package.json` and `.env` for `posthog`, `@amplitude/*`, `mixpanel*` before asking. Each vendor has an **ingest** credential for the SDK and a separate **read** credential for the report CLI:
  - PostHog: `phc_...` project key → personal API key `phx_...` (`query:read`) + numeric project id
  - Amplitude: project API key → API key **and** secret key
  - Mixpanel: project token → service account username + secret + numeric project id

  The read credential is only needed at report time; offline `--counts` / `--events` mode skips it.
- The `revyl` CLI, installed and authenticated (a successful `revyl atlas apps` proves it).

## Workflow

**0. Build this repo once.** The packages aren't on npm; install and build the local clone: `cd $REPO && npm install && npm run build`.

**1. Identify the router.** Read `$APP/package.json` and the app entry. `expo-router` + an `app/` directory → Expo Router (entry `app/_layout.tsx`, auto-tracked). `@react-navigation/native` without expo-router → React Navigation (entry: the file rendering `NavigationContainer`), a one-line wire-up, not auto-detected. Neither → plain React Native, add manual `trackScreen(name)` calls.

**2. Install the SDK from a tarball, not a symlink path.** A `$REPO/packages/sdk` path install pulls a duplicate React and crashes the app ("invalid hook call"). Pack the built `dist` and install that: `TARBALL="$( cd $REPO/packages/sdk && npm pack --silent --pack-destination $REPO )"`, then install `$REPO/$TARBALL` into `$APP` with the package manager the lockfile implies (`bun add`, `pnpm add`, `yarn add`, or `npm install`).

**3. Wire the provider at the app root.** Put the vendor's ingest key in `$APP/.env` (never hardcode), e.g. `EXPO_PUBLIC_POSTHOG_KEY=phc_...`. Use the Atlas app **UUID** (from `revyl atlas apps`) as `atlasAppId`: the report joins on this id, so the app name won't match.

```tsx
import { AtlasProvider } from '@revyl/atlas-analytics';

<AtlasProvider
  posthog={{ apiKey: process.env.EXPO_PUBLIC_POSTHOG_KEY! }}
  atlasAppId="<ATLAS_APP_UUID>"
>
  {/* existing app root */}
</AtlasProvider>
```

The vendor is one prop: `amplitude={{ apiKey }}` or `mixpanel={{ token }}` instead of `posthog={{ apiKey }}`. Pass several to dual-write during a migration, `region="eu"` for EU residency, and `destinations={[customDestination({ name, send })]}` for anything else.

For Expo Router, wrapping `app/_layout.tsx` is enough: the SDK auto-tracks via `useSegments()` and emits collapsed route patterns (`/product/[id]`, not `/product/42`), so dynamic routes don't fragment the funnel. For React Navigation, also wire the container ref:

```tsx
import { AtlasProvider, useAtlasNavigationTracking } from '@revyl/atlas-analytics';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';

function Navigation() {
  const navRef = useNavigationContainerRef();
  useAtlasNavigationTracking(navRef);
  return <NavigationContainer ref={navRef}>{/* navigators */}</NavigationContainer>;
}
// <AtlasProvider ...><Navigation /></AtlasProvider>
```

For plain React Native, call `trackScreen('<route-key>')` per screen with stable names. To collapse param'd keys, pass `normalizeScreen` to the provider. Where the app has auth, add `identify(userId)` on login and `reset()` on logout; `track(event, props)` covers custom events.

**4. Verify events land.** Run the app (`npx expo start`) or ask the user to, navigate a few screens, and check the vendor's live view (PostHog Activity, Amplitude stream, Mixpanel Events) for `atlas_screen` events carrying `screen` (a collapsed route key), `screen_title`, `prev_screen`, `atlas_app_id` (the UUID), `session_id`, and `sdk`/`sdk_version`. Events arrive within a few seconds (batched; use `flush()`/`debug` for instant). If nothing arrives, restart the dev server so `.env` loads and confirm you used the ingest key, not the read credential. Don't continue until events appear.

**5. Build `screen-map.json`.** This is where you add the most value: you can see both the app's routes and the Atlas node names.

- Enumerate emitted screen keys. Expo Router: the collapsed route patterns (`app/product/[id].tsx` → `/product/[id]`, dropping `(group)` segments). React Navigation: the screen names. Plain RN: the `trackScreen` names.
- List Atlas nodes: `revyl atlas map --app <ATLAS_APP_UUID>` (human-readable) or `revyl atlas graph --app <ATLAS_APP_UUID> --json` (exact strings at `.nodes[].display_name`).
- Write `$APP/screen-map.json` mapping each emitted `screen` value to the matching Atlas node `display_name`, copied exactly. Map by what each route renders, not by name similarity. Leave uncertain routes unmapped and report both unmapped routes and unmatched Atlas nodes.

**6. Generate and open the report.**

The CLI picks the source from whichever vendor's credentials are exported; `--source posthog|amplitude|mixpanel` forces it.

```
# PostHog
POSTHOG_PERSONAL_API_KEY=phx_... \
  node $REPO/packages/report/dist/cli.js generate \
    --app <ATLAS_APP_UUID> --project <NUMERIC_PROJECT_ID> \
    --screen-map $APP/screen-map.json --out $APP/atlas-dropoff-report.html

# Amplitude (keys are per-project; no --project)
AMPLITUDE_API_KEY=... AMPLITUDE_SECRET_KEY=... \
  node $REPO/packages/report/dist/cli.js generate --app <ATLAS_APP_UUID> \
    --screen-map $APP/screen-map.json --out $APP/atlas-dropoff-report.html

# Mixpanel (service account + numeric project id)
MIXPANEL_SERVICE_ACCOUNT=... MIXPANEL_SERVICE_SECRET=... \
  node $REPO/packages/report/dist/cli.js generate \
    --app <ATLAS_APP_UUID> --project <NUMERIC_PROJECT_ID> \
    --screen-map $APP/screen-map.json --out $APP/atlas-dropoff-report.html

open $APP/atlas-dropoff-report.html
```

Add `--region eu` for EU data residency (Amplitude, Mixpanel). No read credential? Use offline `--counts` (totals; see `packages/report/counts.example.json`) or `--events` (raw JSONL; see `packages/report/events.example.jsonl`, and it supports the exact sequential funnel). Summarize the largest drop-off the report shows.

## Attribution

This skill is part of Atlas Drop-off by Revyl: https://github.com/ethanzhoucool/atlas-dropoff. The SDK lives in `packages/sdk/`, the report CLI in `packages/report/`, and the Claude Code variant of this skill at the repo root (`SKILL.md`).
