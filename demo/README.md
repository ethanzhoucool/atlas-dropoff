# Demos: real end-to-end drop-off reports

These aren't mockups. Each was produced by the real pipeline: simulated sessions driven through the *actual* `@revyl/atlas-analytics` client (`packages/sdk/dist`) into PostHog project **App** (`111361`), then rendered by `atlas-report` against a real Revyl Atlas map + screenshots.

| Report | App | Funnel | Result |
| --- | --- | --- | --- |
| [`vault-report.html`](vault-report.html) | **Vault** (fintech KYC) | 9-step onboarding: welcome → email → phone → OTP → address → ID → face scan → approved → home | 1,892 → 250 (**13.2%**); biggest leak **ID → Face Scan (−46%)**, the liveness/selfie step |
| [`crate-report.html`](crate-report.html) | **Crate** (storefront) | 5-step checkout: home → collection → product → checkout → confirmation | 1,201 → 140 (**11.7%**); biggest leak **Product → Checkout (−58%)** |

## How each was made

1. **Real SDK → real PostHog.** `seed-vault.cjs` / `seed-crate.cjs` spin up a fresh `AtlasClient` per simulated session (one distinct user each) and emit `atlas_screen` events (the same batching + `/batch/` transport a shipping app uses). `react-native` is the only stub (so the client runs under Node).
2. **Real Atlas map.** `atlas-report` pulls each app's screen graph + screenshots via the `revyl` CLI.
3. **Real join.** The `*-counts.json` files hold the `count(DISTINCT person_id)` numbers read back from PostHog; `*-screen-map.json` maps the emitted route keys onto Atlas nodes.

These two demos ran through PostHog because that's what the seeders targeted. The Amplitude and Mixpanel sources answer the same three questions against their own APIs and produce an identical report — see the source table in the [root README](../README.md#bring-your-own-analytics).

> Traffic here is seeded through the real SDK code path (the apps aren't shipped with the SDK yet); in a live app the same events come from real users.

## Testing the live PostHog query path (no personal key needed)

`atlas-report` normally queries PostHog live (`POSTHOG_PERSONAL_API_KEY` + `--project`). To exercise that path without a key, `mock-posthog.cjs` stands in for PostHog's query API and replays the real queried rows:

```bash
node demo/mock-posthog.cjs 8799 &
POSTHOG_PERSONAL_API_KEY=test node packages/report/dist/cli.js generate \
  --app 449ae04e-24b3-45a6-b125-c628092c441e --project 111361 --host http://localhost:8799 \
  --screen-map demo/vault-screen-map.json --atlas-cache demo/.atlas-cache/vault --out /tmp/vault-live.html
```

This runs the generator's real `fetch` → HogQL → response-parse code: the screens + transitions + leavers queries, plus the sequential `windowFunnel` query for exact conversion (live mode uses it; offline `--counts` uses the min-cohort estimate). Because `windowFunnel` dedupes by `person_id`, the live Vault number lands at 13.2%, matching the cleaned offline counts.

## Amplitude and Mixpanel, end to end

`mock-vendors.cjs` is a small but real implementation of both vendors' APIs: it
**ingests** on their capture endpoints and **answers** their query endpoints by
computing over what it stored. So the whole loop runs — real SDK → vendor
capture API → vendor query API → real report CLI — and a wrong payload mapping
or a wrong response parse shows up as wrong numbers.

```bash
node demo/mock-vendors.cjs 8790 &
node demo/seed-vendors.cjs http://localhost:8790     # same 1,200 Crate sessions as seed-crate.cjs

AMPLITUDE_API_KEY=k AMPLITUDE_SECRET_KEY=s node packages/report/dist/cli.js generate \
  --app cda16afc-2b9c-4042-a0c2-d863dc3c9ec6 --host http://localhost:8790 \
  --screen-map demo/crate-screen-map.json --atlas-cache demo/.atlas-cache/crate \
  --out /tmp/crate-amplitude.html

MIXPANEL_SERVICE_ACCOUNT=sa MIXPANEL_SERVICE_SECRET=sk node packages/report/dist/cli.js generate \
  --app cda16afc-2b9c-4042-a0c2-d863dc3c9ec6 --source mixpanel --project 42 --host http://localhost:8790 \
  --screen-map demo/crate-screen-map.json --atlas-cache demo/.atlas-cache/crate \
  --out /tmp/crate-mixpanel.html
```

Both land on the PostHog demo's numbers — 11.7% converted, biggest leak
Product → Checkout −58% — with per-screen users and exit rates identical across
all three sources. (The PostHog run counts one extra user on the home screen:
the preflight event `seed-crate.cjs` sends before seeding.)

## The same report from a raw event stream

`--events <file.jsonl>` reads raw events from any vendor's export and computes
the counts (and a true sequential funnel) locally. On the Crate data it lands on
exactly the numbers above — 1,201 entered, 11.7% converted, biggest leak
Product → Checkout −58% — reached by a different code path from the `--counts`
run, which is a useful cross-check of both.

```bash
node packages/report/dist/cli.js generate \
  --app cda16afc-2b9c-4042-a0c2-d863dc3c9ec6 \
  --events <your-export.jsonl> --screen-map demo/crate-screen-map.json \
  --atlas-cache demo/.atlas-cache/crate --out /tmp/crate-events.html
```

See `packages/report/events.example.jsonl` for the line format.

## Regenerate a report

```bash
# from the repo root, after `npm install && npm run build`
node packages/report/dist/cli.js generate \
  --app 449ae04e-24b3-45a6-b125-c628092c441e \
  --counts demo/vault-counts.json --screen-map demo/vault-screen-map.json \
  --atlas-cache demo/.atlas-cache/vault --out demo/vault-report.html
```

Note: the Vault screen-map targets specific Atlas node **ids** (not names) because Vault's Atlas has duplicate node names, and the cached screenshots were pinned to the app's consistent all-black build.
