# @ethanzhoucool/atlas-report

Turn a **Revyl Atlas** screen map + **PostHog** `atlas_screen` events into a single,
self-contained HTML drop-off report.

Revyl's Atlas already knows your app's structure: every node is a real screen
observed on a cloud device (with a screenshot), every edge a real transition. The
companion mobile SDK emits one `atlas_screen` event per screen view to PostHog.
`atlas-report` joins the two. There is no manual funnel-building in PostHog, because
the Atlas graph is the funnel definition:

1. pulls the Atlas graph + one representative screenshot per screen (via the `revyl` CLI, cached),
2. queries PostHog for distinct users per screen and per screen-to-screen transition,
3. maps PostHog screen keys onto Atlas nodes,
4. computes the primary funnel + per-screen drop-off,
5. renders one HTML file: flow map with real screenshots and drop-off "heat"
   painted on each screen, a narrowing funnel view, and a per-screen detail drawer.
   All CSS/JS/screenshots are inlined; it opens from `file://` and is safe to share.
   (Google Fonts is the only external reference.)

## Install & build

```sh
cd packages/report
npm install        # dev deps only (typescript + @types/node)
npm run build      # tsc → dist/
npx atlas-report --help
```

Requires Node >= 18 (uses global `fetch`). No runtime dependencies.

## Environment variables

| Variable                   | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `POSTHOG_PERSONAL_API_KEY` | Personal API key for the PostHog **query** API (`query:read`). Required unless `--counts` is used. |
| `POSTHOG_PROJECT_ID`       | Default for `--project`.                                        |
| `POSTHOG_HOST`             | Default for `--host` (default `https://us.posthog.com`). Note: this is the **query** API host, which differs from the capture host (`us.i.posthog.com`). |

## CLI reference

```
atlas-report generate --app <atlas-app-id-or-name> [options]

  --app <id|name>       Revyl Atlas app id or name (required)
  --project <id>        PostHog project id (default: $POSTHOG_PROJECT_ID)
  --host <url>          PostHog query API host (default: $POSTHOG_HOST or https://us.posthog.com)
  --days <n>            Lookback window in days, 1-3650 (default: 28)
  --timeout <s>         PostHog query timeout in seconds (default: 60)
  --funnel-window <s>   Sequential-funnel conversion window in seconds
                        (live mode; default: the full lookback, days*86400)
  --screen-map <file>   JSON map of PostHog screen keys -> Atlas node id/name
  --out <file>          Output HTML path (default: atlas-dropoff-report.html)
  --atlas-cache <dir>   Atlas graph + screenshot cache (default: .atlas-cache/<app>)
  --refresh             Ignore the cache and re-fetch the Atlas graph
  --counts <file>       Offline mode: read precomputed counts JSON instead of querying PostHog
  --revyl <path>        Path to the revyl CLI (default: ~/.revyl/bin/revyl)
  -h, --help            Show help
  -v, --version         Print the version
```

### Sample invocations

```sh
# Live: pull Atlas, query PostHog, render
export POSTHOG_PERSONAL_API_KEY=phx_...
atlas-report generate --app parrot --project 12345 --days 28 --out parrot-dropoff.html

# Offline / demo: no PostHog key needed
atlas-report generate --app parrot --counts counts.example.json

# Re-pull the Atlas graph and force custom screen mapping
atlas-report generate --app 487f7ab4-eec3-437f-b435-da9dd944e5b8 \
  --refresh --screen-map screen-map.example.json
```

## The event contract

The report expects `atlas_screen` events with these properties (emitted by the
companion `atlas-analytics` SDK, whose contract is frozen):

```json
{
  "event": "atlas_screen",
  "distinct_id": "u_8f3a...",
  "timestamp": "2026-07-16T12:00:00Z",
  "properties": {
    "screen": "onboarding/goal",
    "screen_title": "Pick a goal",
    "prev_screen": "onboarding/welcome",
    "atlas_app_id": "487f7ab4-eec3-437f-b435-da9dd944e5b8",
    "session_id": "s_abc",
    "sdk": "atlas-analytics-rn",
    "sdk_version": "0.1.0"
  }
}
```

`screen` is the canonical route key (the join key to Atlas nodes); `prev_screen`
attributes transitions. The three HogQL queries generated are:

```sql
-- per screen
SELECT properties.screen AS screen,
       count(DISTINCT person_id) AS users,
       count() AS events
FROM events
WHERE event = 'atlas_screen'
  AND properties.atlas_app_id = {app_id}
  AND timestamp > now() - INTERVAL <days> DAY
GROUP BY screen
ORDER BY users DESC

-- per transition
SELECT properties.prev_screen AS src,
       properties.screen AS dst,
       count(DISTINCT person_id) AS users
FROM events
WHERE event = 'atlas_screen'
  AND properties.atlas_app_id = {app_id}
  AND properties.prev_screen IS NOT NULL
  AND properties.prev_screen != ''
  AND timestamp > now() - INTERVAL <days> DAY
GROUP BY src, dst
ORDER BY users DESC

-- leavers: distinct users who navigated FROM each screen to any next screen
SELECT properties.prev_screen AS src,
       count(DISTINCT person_id) AS leavers
FROM events
WHERE event = 'atlas_screen'
  AND properties.atlas_app_id = {app_id}
  AND properties.prev_screen != ''
  AND timestamp > now() - INTERVAL <days> DAY
GROUP BY src
```

**The uniqueness metric is `count(DISTINCT person_id)`** (person-on-events),
not `distinct_id`: one identified person spans multiple pre-identify device
ids, so counting `distinct_id` would over-count unique users. The leavers
query powers `exit_rate = 1 − leavers/users`; summing per-destination
transition counts instead would double-count users who left to multiple
destinations and bias exit rates low.

`{app_id}` is bound server-side via HogQL `values` (proper parameterization);
`<days>` is validated as an integer in 1–3650 before being placed in the SQL.

## `--counts` offline schema

Skip the live PostHog query entirely and feed precomputed counts. This makes the
tool runnable/demoable without any API key:

```json
{
  "date_range": "Last 28 days",
  "screens": {
    "<screenKey>": { "users": 123, "events": 456 }
  },
  "transitions": [
    { "src": "<screenKey>", "dst": "<screenKey>", "users": 98 }
  ],
  "leavers": {
    "<screenKey>": 110
  }
}
```

- `screens`: required. `users` = distinct users who viewed the screen;
  `events` = raw view count (defaults to `users` when omitted).
- `transitions`: optional (may be empty). Distinct users who went
  `src → dst`. Without transitions, the funnel is derived by walking the Atlas
  structure (primary edges first) across screens that have data.
- `leavers`: optional. Distinct users who navigated FROM the screen to any
  next screen. When present, `exit_rate = 1 − leavers/users` (matches the live
  leavers query). When absent, exit rates fall back to summing the
  per-destination transition counts, an approximation that double-counts
  users who left to multiple destinations, so it can bias exit rates low
  (a stderr note is printed).
- `date_range`: optional label shown in the report header.

See `counts.example.json` for a complete working example.

## `--screen-map` format

If your PostHog `screen` keys don't match Atlas node names, map them explicitly.
Values may be an Atlas node **id** or **display name** (fuzzy-normalized names
also resolve):

```json
{
  "onboarding/welcome": "onboarding_splash_welcome",
  "home": "home_dashboard",
  "lesson/complete": "1b2f3c4d-5e6f-7081-92a3-b4c5d6e7f809"
}
```

Without a screen map, keys are auto-matched: exact match on node name/id first,
then a normalized match (lowercased, separators stripped, so `onboarding/welcome`
matches `Onboarding_Welcome`). A mapping report is printed to stderr on every run:
matched keys, unmatched PostHog keys, and Atlas screens with no analytics data.
Unmatched keys never crash the run. They simply carry no data.

## How the funnel is derived

- **Entry**: the busiest Atlas entry-point screen with data, unless that entry
  point sees less than 50% of the busiest screen's users (e.g. a rarely-viewed
  splash), in which case the busiest screen overall is used so step 2 can never
  exceed step 1. Busiest overall is also used when Atlas marked no entry points.
- **Path**: from each screen, follow the highest-volume observed transition to an
  unvisited screen with data; stop at a terminal screen or a dead end.
- **Conversion (end-to-end and per step)**: driven by a monotone funnel cohort.
  - Live mode runs a real **sequential funnel** (HogQL `windowFunnel`) over the
    discovered path: distinct persons who completed the first *k* steps in order,
    where each step matches any screen key mapped to that node (so aliases dedupe
    by `person_id`). This is exact. `--funnel-window` sets how long the ordered
    sequence may span (default: the full lookback).
  - Offline `--counts` mode has no per-user data, so it estimates the cohort with
    `cohort[i] = min(cohort[i-1], transition_i)` (falling back to the step's
    viewers when a transition is missing). Monotone by construction, and an upper
    bound on true traversal.
  - `lost` is the previous cohort minus the current one. Per-screen `exit_rate`
    uses the leavers counts (`1 − leavers/users`) when available; "where they go
    next" shares come from the per-destination transitions. Per-screen viewer
    totals (everyone who saw a screen, by any path) still drive the flow map.
- **Off-funnel screens** with traffic appear as smaller side nodes anchored to the
  funnel screen they exchange the most users with.

Per-screen metrics that can't be derived from screen-view events alone
(median time on screen, rage taps, average taps) are omitted. The drawer hides
those cells rather than showing fake numbers.

## Cache layout

```
.atlas-cache/<app>/
  atlas.json        # normalized graph (same shape as atlas-funnel's atlas.json)
  atlas_raw.json    # raw CLI payload, for debugging
  screens/<node-id>.png
```

Reused on every run unless `--refresh` is passed.
