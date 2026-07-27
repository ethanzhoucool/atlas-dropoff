# @revyl/atlas-report

Turn a **Revyl Atlas** screen map + `atlas_screen` events from **PostHog,
Amplitude, or Mixpanel** into a single, self-contained HTML drop-off report.

Revyl's Atlas already knows your app's structure: every node is a real screen
observed on a cloud device (with a screenshot), every edge a real transition. The
companion mobile SDK emits one `atlas_screen` event per screen view to whichever
analytics vendor you use. `atlas-report` joins the two. There is no manual
funnel-building in your analytics tool, because the Atlas graph is the funnel
definition:

1. pulls the Atlas graph + one representative screenshot per screen (via the `revyl` CLI, cached),
2. queries your analytics source for distinct users per screen and per screen-to-screen transition,
3. maps event screen keys onto Atlas nodes,
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

## Sources

One event contract, five ways to read it back. The source is chosen
automatically: `--counts`/`--events` win, then the single vendor whose
credentials are present, else PostHog. `--source <name>` forces it.

| `--source` | Credentials | Sequential funnel |
| ---------- | ----------- | ----------------- |
| `posthog`  | `POSTHOG_PERSONAL_API_KEY` + `--project` | HogQL `windowFunnel` — exact |
| `amplitude` | `AMPLITUDE_API_KEY` + `AMPLITUDE_SECRET_KEY` | `/api/2/funnels`, `mode=ordered` — exact |
| `mixpanel` | `MIXPANEL_SERVICE_ACCOUNT` + `MIXPANEL_SERVICE_SECRET` + `--project` | computed locally from the raw export — exact |
| `counts`   | none (`--counts <file>`) | min-cohort estimate |
| `events`   | none (`--events <file>`) | computed locally — exact |

**PostHog** runs three HogQL aggregates plus a `windowFunnel` query (see below).

**Amplitude** runs three Dashboard REST segmentation queries (`m=uniques`,
grouped by `screen`, by `prev_screen`+`screen`, and by `prev_screen`) and reads
`seriesCollapsed` — Amplitude's range-deduplicated total. Summing the daily
`series` values instead would double-count anyone who came back. The funnel is
`GET /api/2/funnels` with one step per Atlas node, each filtered to that node's
screen keys, `mode=ordered` and `cs=<--funnel-window>`. Amplitude prices a query
at `days × conditions × 2` and refuses anything over ~1000, so a funnel too
expensive for the window is reported and skipped (the report falls back to the
estimate) rather than fired and 429'd.

**Mixpanel** streams the raw event export
(`GET data.mixpanel.com/api/2.0/export`, filtered to this `atlas_app_id`,
`time_in_ms` so screens emitted inside the same second stay ordered) and
aggregates in-process. Its segmentation API only reports uniques *per time
unit*, and summing days over-counts returning users — there is no
range-collapsed unique to ask for. Counting locally is both correct and enough
to compute a true sequential funnel. Use `--max-events` to bound a very large
window.

## Environment variables

| Variable                   | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `POSTHOG_PERSONAL_API_KEY` | Personal API key for the PostHog **query** API (`query:read`).  |
| `POSTHOG_PROJECT_ID`       | Default for `--project`.                                        |
| `POSTHOG_HOST`             | Default for `--host` (default `https://us.posthog.com`). Note: this is the **query** API host, which differs from the capture host (`us.i.posthog.com`). |
| `AMPLITUDE_API_KEY`        | Amplitude project API key (Settings → Projects → General).      |
| `AMPLITUDE_SECRET_KEY`     | Amplitude secret key — the Dashboard REST API needs both.       |
| `AMPLITUDE_HOST`           | Default for `--host` (default `https://amplitude.com`, or `https://analytics.eu.amplitude.com` with `--region eu`). |
| `MIXPANEL_SERVICE_ACCOUNT` | Mixpanel service-account username (Project Settings → Service Accounts). |
| `MIXPANEL_SERVICE_SECRET`  | Mixpanel service-account secret.                                |
| `MIXPANEL_PROJECT_ID`      | Default for `--project`; service-account auth requires it.      |
| `MIXPANEL_HOST`            | Default for `--host` (default `https://data.mixpanel.com`, or `https://data-eu.mixpanel.com` with `--region eu`). |

## CLI reference

```
atlas-report generate --app <atlas-app-id-or-name> [options]

SOURCE
  --source <name>       posthog | amplitude | mixpanel | counts | events
  --project <id>        PostHog project id / Mixpanel project id
  --host <url>          Query API host for the chosen vendor
  --region <us|eu>      Vendor data region (default: us)
  --counts <file>       Offline: precomputed counts JSON
  --events <file>       Offline: raw events JSONL (supports the exact funnel)
  --max-events <n>      Cap events read from Mixpanel/--events (default: 2000000)

OPTIONS
  --app <id|name>       Revyl Atlas app id or name (required)
  --days <n>            Lookback window in days, 1-3650 (default: 28)
  --timeout <s>         Per-query timeout in seconds (default: 60)
  --funnel-window <s>   Sequential-funnel conversion window in seconds
                        (default: the full lookback, days*86400)
  --screen-map <file>   JSON map of event screen keys -> Atlas node id/name
  --out <file>          Output HTML path (default: atlas-dropoff-report.html)
  --atlas-cache <dir>   Atlas graph + screenshot cache (default: .atlas-cache/<app>)
  --refresh             Ignore the cache and re-fetch the Atlas graph
  --revyl <path>        Path to the revyl CLI (default: ~/.revyl/bin/revyl)
  -h, --help            Show help
  -v, --version         Print the version
```

### Sample invocations

```sh
# PostHog
export POSTHOG_PERSONAL_API_KEY=phx_...
atlas-report generate --app parrot --project 12345 --days 28 --out parrot-dropoff.html

# Amplitude (no --project; the keys are per-project already)
export AMPLITUDE_API_KEY=... AMPLITUDE_SECRET_KEY=...
atlas-report generate --app parrot --days 14

# Mixpanel, EU residency
export MIXPANEL_SERVICE_ACCOUNT=... MIXPANEL_SERVICE_SECRET=...
atlas-report generate --app parrot --project 3141592 --region eu

# Offline / demo: no credentials needed
atlas-report generate --app parrot --counts counts.example.json
atlas-report generate --app parrot --events events.example.jsonl

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
    "sdk_version": "0.2.0"
  }
}
```

`screen` is the canonical route key (the join key to Atlas nodes); `prev_screen`
attributes transitions. The three HogQL queries generated for the PostHog
source are:

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

## `--events` offline schema

One JSON object per line. Both the vendor-export envelope and a flat row work,
and the id falls back through `distinct_id` → `$user_id` → `user_id` →
`$device_id` → `device_id` → `person_id`, so most exports need no reshaping.
`time` may be seconds, milliseconds, or an ISO string.

```jsonl
{"event":"atlas_screen","properties":{"screen":"/","prev_screen":null,"distinct_id":"u_001","atlas_app_id":"<uuid>","time":1785110400}}
{"screen":"/collection","prev_screen":"/","distinct_id":"u_001","timestamp":"2026-07-27T00:00:30Z"}
```

Lines for other events, other apps, or without a screen/user are skipped and
counted. Unlike `--counts`, this keeps per-user chronology, so the funnel is a
real sequential one rather than an estimate. See `events.example.jsonl`.

**Identity is stitched locally too.** When a row carries both a device id and a
user id (`$device_id` + `$user_id`, or `device_id` + `user_id`), that pairing is
recorded and the anonymous timeline is folded into the person at query time. So
a user who signs up mid-funnel counts once, whether or not the export already
resolved them — otherwise the login step would look like total drop-off.

## `--counts` offline schema

Skip the live query entirely and feed precomputed counts. This makes the
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

If your `screen` keys don't match Atlas node names, map them explicitly.
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
matched keys, unmatched screen keys, and Atlas screens with no analytics data.
Unmatched keys never crash the run. They simply carry no data.

## How the funnel is derived

- **Entry**: the busiest Atlas entry-point screen with data, unless that entry
  point sees less than 50% of the busiest screen's users (e.g. a rarely-viewed
  splash), in which case the busiest screen overall is used so step 2 can never
  exceed step 1. Busiest overall is also used when Atlas marked no entry points.
- **Path**: from each screen, follow the highest-volume observed transition to an
  unvisited screen with data; stop at a terminal screen or a dead end.
- **Conversion (end-to-end and per step)**: driven by a monotone funnel cohort.
  - Sources with per-user data run a real **sequential funnel** over the
    discovered path: distinct users who completed the first *k* steps in order,
    where each step matches any screen key mapped to that node (so aliases dedupe
    by user). This is exact. `--funnel-window` sets how long the ordered
    sequence may span (default: the full lookback). PostHog uses HogQL
    `windowFunnel`, Amplitude `/api/2/funnels` in `ordered` mode, and
    Mixpanel/`--events` the equivalent computed locally.
  - `--counts` mode has no per-user data, so it estimates the cohort with
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
