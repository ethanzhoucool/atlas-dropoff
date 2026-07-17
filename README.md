# Atlas Drop-off

See where users drop off in your app, painted on your app's own screens. No manual funnel setup.

If your app has a [Revyl Atlas](https://revyl.com) map, your funnel is already defined. Atlas explores your app on cloud devices with a vision-based engine and builds the full screen graph, with screenshots. The one thing that graph is missing is user traffic. A tiny SDK emits one PostHog event per screen, and a report CLI joins those events back onto the Atlas graph. You never hand-build a funnel in PostHog; the screen graph *is* the funnel.

> **Two live reports**, generated end-to-end. A 9-step fintech onboarding funnel ([`demo/vault-report.html`](demo/vault-report.html): 1,892 → 13.2%, biggest leak ID → Face Scan −46%) and a 5-step checkout ([`demo/crate-report.html`](demo/crate-report.html)). Traffic ran through the SDK into PostHog, then rendered on Atlas screenshots. Open one in a browser. ([how they were made](demo/README.md))

## See it in 3 steps

**1. Add the provider** at your app root:

```tsx
import { AtlasProvider } from '@revyl/atlas-analytics';

<AtlasProvider
  apiKey={process.env.EXPO_PUBLIC_POSTHOG_KEY!}   // PostHog project (phc_) key
  atlasAppId="<your-atlas-app-id>"                 // the UUID from `revyl atlas apps`
>
  <App />
</AtlasProvider>
```

No native modules, works in Expo Go. Expo Router is auto-detected: dynamic routes collapse to their pattern (`/product/[id]`, not `/product/42`), so the funnel doesn't fragment. React Navigation is a one-line wire-up (`useAtlasNavigationTracking`). Each screen view becomes one `atlas_screen` event.

**2. Run your app.** Navigate around. Events land in PostHog's live Activity view within a few seconds (the SDK batches; `flush()` or `debug` for instant confirmation).

**3. Generate the report:**

```
node packages/report/dist/cli.js generate --app <your-atlas-app-id> --project <posthog-project-id>
```

You get a single self-contained `report.html`: your app's screenshots from Atlas, with user counts and drop-off percentages on every screen transition. Open it and find the leak in your onboarding or checkout.

## Install & build

The packages aren't on npm yet. Clone this repo and build once:

```
npm install && npm run build
```

Then install the SDK into your app from this local path (`npm install <path>/packages/sdk`), and run the report with `node <path>/packages/report/dist/cli.js …`. The agent skill (below) does all of this for you.

## Tell your coding agent to set this up for you

This repo ships as an agent skill. Open it in your app's workspace and type, to Claude Code or Codex:

> Open the atlas-dropoff repo and integrate it into my app.

The skill takes over: it builds the repo, detects your router (Expo Router, React Navigation, or plain RN), installs the SDK, wires `AtlasProvider` with your PostHog key from env, verifies events land, builds a `screen-map.json` by reading your routes *and* your live Atlas graph (`revyl atlas graph --app <id> --json`), and generates the report. The screen-map step is where an agent shines: it has both your route keys and your Atlas node names in context, so the mapping comes out right.

- Claude Code reads `SKILL.md` at the repo root (also installable as a plugin via `.claude-plugin/`).
- Codex reads `codex-skill/SKILL.md`.

## Repo layout

```
atlas-dropoff/
├── packages/
│   ├── sdk/            @revyl/atlas-analytics: Expo/RN SDK, one atlas_screen event per screen
│   └── report/         atlas-report: Node CLI that renders report.html from Atlas + PostHog
├── demo/               a real end-to-end report + the seeder that produced it
├── SKILL.md            Claude Code skill (full integration workflow)
├── metadata.json       Skill metadata
├── .claude-plugin/     plugin.json + marketplace.json (Claude Code plugin packaging)
└── codex-skill/        Codex-native skill variant (+ agents/openai.yaml)
```

## The event contract

One event, frozen schema. Everything joins on `screen`.

| Field | Description |
| --- | --- |
| event | `atlas_screen`, sent once per screen view |
| `screen` | Canonical route key (a collapsed route pattern). The join key to Atlas nodes. |
| `screen_title` | Human-readable screen title |
| `prev_screen` | Route key of the previous screen (`null` on the first screen of a session) |
| `atlas_app_id` | The Revyl Atlas app **id** (UUID) this event belongs to |
| `session_id` | Session identifier |
| `distinct_id` | PostHog identity (set via `identify`, cleared via `reset`) |
| `sdk`, `sdk_version` | SDK name and version |

The SDK also exposes `identify(userId)`, `reset()`, `trackScreen(name)` for manual tracking, `track(event, props)` for custom events, and a `normalizeScreen` config option to collapse param'd keys (e.g. `/users/123` → `/users/[id]`). See [`packages/sdk/README.md`](packages/sdk/README.md).

Route keys rarely match Atlas node names one-to-one, so `atlas-report` accepts a mapping (`--screen-map screen-map.json`) from your route keys to Atlas node `display_name`s. The agent skill builds this file for you.

## Prerequisites

- A Revyl Atlas map for your app (`revyl atlas apps` lists your apps and their UUIDs). Atlas maps are built by Revyl's vision-based engine exploring your app on cloud devices.
- A PostHog project:
  - the project API key (`phc_...`) for the SDK. Put it in `EXPO_PUBLIC_POSTHOG_KEY`, don't hardcode.
  - a personal API key (`phx_...`, `query:read`) plus the numeric project id for the report CLI. Or skip both with offline `--counts` mode (see `packages/report/README.md`).
- The `revyl` CLI, installed and authenticated.

## License

MIT. See [LICENSE](LICENSE).
