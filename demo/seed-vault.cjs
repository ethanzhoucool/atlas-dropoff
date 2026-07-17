/**
 * Demo seeder #2 — a long KYC onboarding funnel (Vault).
 *
 * Same real pipeline as seed-crate.cjs: drives simulated onboarding sessions
 * through the actual @revyl/atlas-analytics client into PostHog project App
 * (111361), tagged with Vault's Atlas app id. Vault is a real fintech app with
 * a 9-step KYC onboarding flow already mapped in Revyl Atlas — the canonical
 * high-drop-off funnel (SMS OTP, document capture, and liveness/selfie each
 * shed users).
 *
 *   node demo/seed-vault.cjs
 */

const path = require("path");
const Module = require("module");

const rnStub = { AppState: { addEventListener: () => ({ remove() {} }) } };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "react-native") return rnStub;
  return origLoad.apply(this, arguments);
};

const { AtlasClient } = require(path.join(
  __dirname,
  "..",
  "packages",
  "sdk",
  "dist",
  "client.js"
));

const API_KEY = "phc_5J0lU7F9qmS7yt8ElfHnCmhxXJM8I5B8PeayaMGaXEZ"; // PostHog "App" (111361) ingest key
const ATLAS_APP_ID = "449ae04e-24b3-45a6-b125-c628092c441e"; // Vault
const HOST = "https://us.i.posthog.com";
const CONCURRENCY = 25;

// The KYC onboarding flow, in order (route key + title). Each maps to a real
// Vault Atlas node via demo/vault-screen-map.json.
const FUNNEL = [
  ["/onboarding/welcome", "Welcome"],
  ["/onboarding/email", "Email"],
  ["/onboarding/phone", "Phone number"],
  ["/onboarding/verify", "Verify phone"],
  ["/onboarding/address", "Home address"],
  ["/onboarding/id", "ID document"],
  ["/onboarding/face-scan", "Face scan"],
  ["/onboarding/approved", "Approved"],
  ["/home", "Home"],
];

// How many sessions drop at each depth (1 = saw Welcome only … 9 = reached Home).
// Tuned to published KYC benchmarks: OTP, document capture, and liveness leak hardest.
const DROP_AT_DEPTH = [
  [1, 260], // Welcome only
  [2, 220], // ... Email
  [3, 340], // ... Phone
  [4, 170], // ... Verify (SMS OTP)
  [5, 320], // ... Address
  [6, 260], // ... ID document
  [7, 70],  // ... Face scan
  [8, 5],   // ... Approved
  [9, 355], // reached Home (converted)
];

function buildSessions() {
  const sessions = [];
  for (const [depth, count] of DROP_AT_DEPTH) {
    for (let i = 0; i < count; i++) sessions.push(FUNNEL.slice(0, depth));
  }
  return sessions;
}

async function runSession(steps) {
  const c = new AtlasClient({
    apiKey: API_KEY,
    atlasAppId: ATLAS_APP_ID,
    host: HOST,
    flushAt: 1000,
    flushInterval: 3600000,
  });
  for (const [key, title] of steps) c.trackScreen(key, { title });
  await c.shutdown();
}

async function preflight() {
  const res = await fetch(`${HOST}/batch/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      historical_migration: false,
      batch: [
        {
          event: "atlas_screen",
          distinct_id: "atlas_dropoff_vault_preflight",
          timestamp: new Date().toISOString(),
          properties: {
            screen: "/onboarding/welcome",
            $screen_name: "/onboarding/welcome",
            atlas_app_id: ATLAS_APP_ID,
            sdk: "atlas-analytics-rn",
            sdk_version: "0.1.0",
            _preflight: true,
          },
        },
      ],
    }),
  });
  console.log(`preflight POST /batch/ -> HTTP ${res.status} ${(await res.text()).slice(0, 80)}`);
  if (!res.ok) throw new Error(`preflight failed (HTTP ${res.status})`);
}

async function main() {
  await preflight();
  const sessions = buildSessions();
  console.log(`seeding ${sessions.length} KYC onboarding sessions...`);
  let done = 0;
  let failed = 0;
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    const res = await Promise.allSettled(sessions.slice(i, i + CONCURRENCY).map(runSession));
    for (const r of res) r.status === "fulfilled" ? done++ : failed++;
    process.stdout.write(`\r  ${done}/${sessions.length} sessions sent (${failed} failed)`);
  }
  console.log(`\nseed complete: ${done} sessions, ${failed} failed`);
}

main().catch((e) => {
  console.error("seed error:", e.message);
  process.exit(1);
});
