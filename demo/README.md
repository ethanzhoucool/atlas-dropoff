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

> Traffic here is seeded through the real SDK code path (the apps aren't shipped with the SDK yet); in a live app the same events come from real users.

## Testing the live PostHog query path (no personal key needed)

`atlas-report` normally queries PostHog live (`POSTHOG_PERSONAL_API_KEY` + `--project`). To exercise that path without a key, `mock-posthog.cjs` stands in for PostHog's query API and replays the real queried rows:

```bash
node demo/mock-posthog.cjs 8799 &
POSTHOG_PERSONAL_API_KEY=test node packages/report/dist/cli.js generate \
  --app 449ae04e-24b3-45a6-b125-c628092c441e --project 111361 --host http://localhost:8799 \
  --screen-map demo/vault-screen-map.json --atlas-cache demo/.atlas-cache/vault --out /tmp/vault-live.html
```

This runs the generator's real `fetch` → HogQL → response-parse code (screens + transitions + leavers queries, Bearer auth) and produces the same funnel as the offline `--counts` render.

## Regenerate a report

```bash
# from the repo root, after `npm install && npm run build`
node packages/report/dist/cli.js generate \
  --app 449ae04e-24b3-45a6-b125-c628092c441e \
  --counts demo/vault-counts.json --screen-map demo/vault-screen-map.json \
  --atlas-cache demo/.atlas-cache/vault --out demo/vault-report.html
```

Note: the Vault screen-map targets specific Atlas node **ids** (not names) because Vault's Atlas has duplicate node names, and the cached screenshots were pinned to the app's consistent all-black build.
