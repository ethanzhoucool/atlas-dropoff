# Atlas Drop-off

See where users drop off in your app, painted on your app's own screens. No manual funnel setup. Works with **PostHog, Amplitude, or Mixpanel** — whichever you already have.

If your app has a [Revyl Atlas](https://revyl.com) map, your funnel is already defined. Atlas explores your app on cloud devices with a vision-based engine and builds the full screen graph, with screenshots. The one thing that graph is missing is user traffic. A tiny SDK emits one screen event per screen view to your analytics vendor, and a report CLI joins those events back onto the Atlas graph. You never hand-build a funnel in your analytics tool; the screen graph *is* the funnel.

> **Two live reports**, generated end-to-end. A 9-step fintech onboarding funnel ([`demo/vault-report.html`](demo/vault-report.html): 1,892 → 13.2%, biggest leak ID → Face Scan −46%) and a 5-step checkout ([`demo/crate-report.html`](demo/crate-report.html)). Traffic ran through the SDK into PostHog, then rendered on Atlas screenshots. Open one in a browser. ([how they were made](demo/README.md))

## See it in 3 steps

**1. Add the provider** at your app root:

```tsx
import { AtlasProvider } from '@revyl/atlas-analytics';

<AtlasProvider
  posthog={{ apiKey: process.env.EXPO_PUBLIC_POSTHOG_KEY! }}
  atlasAppId="<your-atlas-app-id>"   // the UUID from `revyl atlas apps`
>
  <App />
</AtlasProvider>
```

Using something else? Swap one line: `amplitude={{ apiKey: ... }}` or `mixpanel={{ token: ... }}`. Pass several to dual-write during a migration.

No native modules, works in Expo Go. Expo Router is auto-detected: dynamic routes collapse to their pattern (`/product/[id]`, not `/product/42`), so the funnel doesn't fragment. React Navigation is a one-line wire-up (`useAtlasNavigationTracking`). Each screen view becomes one `atlas_screen` event.

**2. Run your app.** Navigate around. Events land in your vendor's live view within a few seconds (the SDK batches; `flush()` or `debug` for instant confirmation).

**3. Generate the report:**

```
node packages/report/dist/cli.js generate --app <your-atlas-app-id>
```

You get a single self-contained `report.html`: your app's screenshots from Atlas, with user counts and drop-off percentages on every screen transition. Open it and find the leak in your onboarding or checkout.

## Bring your own analytics

One event contract, five ways to read it back. The report picks the source automatically when only one vendor's credentials are set; `--source` forces it.

| Source | Credentials | How the funnel is computed |
| --- | --- | --- |
| `posthog` | `POSTHOG_PERSONAL_API_KEY` + `--project` | HogQL, incl. a real `windowFunnel` sequential funnel |
| `amplitude` | `AMPLITUDE_API_KEY` + `AMPLITUDE_SECRET_KEY` | Dashboard REST: segmentation (range-collapsed uniques) + `/api/2/funnels` (`mode=ordered`) |
| `mixpanel` | `MIXPANEL_SERVICE_ACCOUNT` + `MIXPANEL_SERVICE_SECRET` + `--project` | Raw event export, aggregated locally — exact uniques *and* an exact sequential funnel |
| `--counts <file>` | none | Offline: precomputed totals; funnel is the min-cohort estimate |
| `--events <file>` | none | Offline: raw JSONL from any tool; exact sequential funnel |

```sh
# Amplitude
AMPLITUDE_API_KEY=... AMPLITUDE_SECRET_KEY=... \
  atlas-report generate --app <atlas-app-id>

# Mixpanel (service account + numeric project id)
MIXPANEL_SERVICE_ACCOUNT=... MIXPANEL_SERVICE_SECRET=... \
  atlas-report generate --app <atlas-app-id> --project 3141592

# EU data residency, either vendor
atlas-report generate --app <atlas-app-id> --region eu
```

Why Mixpanel goes through the raw export: its segmentation API reports uniques *per time unit*, and summing days double-counts anyone who came back. Streaming the events and counting distinct users locally is the only honest answer — and it makes the sequential funnel exact rather than estimated.

Anything not listed (Segment, RudderStack, your own collector, a warehouse) plugs into the SDK through `customDestination({ name, send })`; feed the report an export with `--events`.

## Install (copy-paste, no npm account)

The packages aren't on npm yet, so you install from this repo. Paste this in **your app's root directory**. It clones + builds Atlas Drop-off once, then installs the SDK into your app from a packed tarball:

```sh
ATLAS_DIR="$HOME/.atlas-dropoff"
if [ -d "$ATLAS_DIR/.git" ]; then git -C "$ATLAS_DIR" pull -q
else git clone -q https://github.com/ethanzhoucool/atlas-dropoff.git "$ATLAS_DIR"; fi
( cd "$ATLAS_DIR" && npm install && npm run build )
TARBALL="$( cd "$ATLAS_DIR/packages/sdk" && npm pack --silent --pack-destination "$ATLAS_DIR" )"
npm install "$ATLAS_DIR/$TARBALL"
```

Install from the tarball, not `npm install $ATLAS_DIR/packages/sdk`: a symlink path install pulls a duplicate React from the clone and crashes with "invalid hook call". The tarball ships only the built `dist`.

Then wrap your app root in `<AtlasProvider>` (see the 3-step block above, or `SKILL.md`) and generate the report:

```sh
node "$ATLAS_DIR/packages/report/dist/cli.js" generate --app <atlas-app-id>
```

**Or let your coding agent do the whole thing.** Paste this to Claude Code or Codex from your app:

> Integrate Atlas Drop-off into this app. Clone https://github.com/ethanzhoucool/atlas-dropoff into ~/.atlas-dropoff and run `npm install && npm run build` in it. Install its SDK into this app from an `npm pack` tarball of ~/.atlas-dropoff/packages/sdk (not a symlink path install, which pulls a duplicate React and crashes). Then follow ~/.atlas-dropoff/SKILL.md to wrap the app root in AtlasProvider with my analytics key and Revyl Atlas app id, build a screen-map, and generate the drop-off report.

## Tell your coding agent to set this up for you

This repo ships as an agent skill. Open it in your app's workspace and type, to Claude Code or Codex:

> Open the atlas-dropoff repo and integrate it into my app.

The skill takes over: it builds the repo, detects your router (Expo Router, React Navigation, or plain RN), detects which analytics vendor the app already uses, installs the SDK, wires `AtlasProvider`, verifies events land, builds a `screen-map.json` by reading your routes *and* your live Atlas graph (`revyl atlas graph --app <id> --json`), and generates the report. The screen-map step is where an agent shines: it has both your route keys and your Atlas node names in context, so the mapping comes out right.

- Claude Code reads `SKILL.md` at the repo root (also installable as a plugin via `.claude-plugin/`).
- Codex reads `codex-skill/SKILL.md`.

## Repo layout

```
atlas-dropoff/
├── packages/
│   ├── sdk/            @revyl/atlas-analytics: Expo/RN SDK, one atlas_screen event per screen
│   │   └── src/destinations/   posthog · amplitude · mixpanel · custom
│   └── report/         atlas-report: Node CLI that renders report.html from Atlas + your analytics
│       └── src/sources/        posthog · amplitude · mixpanel · counts file · events file
├── demo/               a real end-to-end report + the seeder that produced it
├── SKILL.md            Claude Code skill (full integration workflow)
├── metadata.json       Skill metadata
├── .claude-plugin/     plugin.json + marketplace.json (Claude Code plugin packaging)
└── codex-skill/        Codex-native skill variant (+ agents/openai.yaml)
```

## The event contract

One event, frozen schema, identical across vendors. Everything joins on `screen`.

| Field | Description |
| --- | --- |
| event | `atlas_screen`, sent once per screen view |
| `screen` | Canonical route key (a collapsed route pattern). The join key to Atlas nodes. |
| `screen_title` | Human-readable screen title |
| `prev_screen` | Route key of the previous screen (`null` on the first screen of a session) |
| `atlas_app_id` | The Revyl Atlas app **id** (UUID) this event belongs to |
| `session_id` | Session identifier |
| `sdk`, `sdk_version` | SDK name and version |

Identity rides in each vendor's own dialect: PostHog gets `distinct_id` plus a `$identify` carrying `$anon_distinct_id`; Amplitude gets `device_id` + `user_id` on every event; Mixpanel gets `$device_id` + `$user_id` with a `$device:`-prefixed anonymous `distinct_id` (Simplified ID Merge). All three mean the same thing — pre-login and post-login screens belong to one person, so the funnel doesn't split a user in half at the login step.

The SDK also exposes `identify(userId)`, `reset()`, `trackScreen(name)` for manual tracking, `track(event, props)` for custom events, and a `normalizeScreen` config option to collapse param'd keys (e.g. `/users/123` → `/users/[id]`). See [`packages/sdk/README.md`](packages/sdk/README.md).

Route keys rarely match Atlas node names one-to-one, so `atlas-report` accepts a mapping (`--screen-map screen-map.json`) from your route keys to Atlas node `display_name`s. The agent skill builds this file for you.

## Prerequisites

- A Revyl Atlas map for your app (`revyl atlas apps` lists your apps and their UUIDs). Atlas maps are built by Revyl's vision-based engine exploring your app on cloud devices.
- An analytics project, with two credentials that are usually different:
  - the **ingest** key for the SDK (PostHog `phc_...`, Amplitude API key, Mixpanel project token). Put it in env, don't hardcode.
  - a **read** credential for the report CLI (see the source table above). Or skip it entirely with offline `--counts` / `--events` mode.
- The `revyl` CLI, installed and authenticated.

## License

MIT. See [LICENSE](LICENSE).
