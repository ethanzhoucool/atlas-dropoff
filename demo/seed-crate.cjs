/**
 * Demo seeder for the Atlas Drop-off real loop.
 *
 * Drives realistic checkout-funnel traffic through the REAL @revyl/atlas-analytics
 * client (packages/sdk/dist) into PostHog project "App" (111361), tagged with the
 * Crate Atlas app id. Each simulated session is a fresh AtlasClient, so it gets its
 * own install id -> one distinct user per session (no identity merging).
 *
 * The only shim is `react-native` (AppState), which the client imports for
 * background-flush; everything else — event shape, batching, /batch/ transport —
 * is the shipped SDK code, unmodified.
 *
 *   node demo/seed-crate.cjs
 *
 * All demo events carry properties.sdk = "atlas-analytics-rn" and
 * properties.atlas_app_id = the Crate id, so they are trivially filtered/deleted.
 */

const path = require("path");
const Module = require("module");

// --- stub react-native so the real client runs under plain Node ---------------
const rnStub = { AppState: { addEventListener: () => ({ remove() {} }) } };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
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

// --- config -------------------------------------------------------------------
const API_KEY = "phc_5J0lU7F9qmS7yt8ElfHnCmhxXJM8I5B8PeayaMGaXEZ"; // PostHog "App" (111361) ingest key
const ATLAS_APP_ID = "cda16afc-2b9c-4042-a0c2-d863dc3c9ec6"; // Crate
const HOST = "https://us.i.posthog.com";
const CONCURRENCY = 25;

// Route-like screen keys the SDK would emit in a real Expo app.
// (A screen-map.json bridges these to Crate's Atlas node display_names.)
const HOME = ["/", "Home"];
const SHOP = ["/collection", "Shop"];
const PRODUCT = ["/product/[id]", "Product"];
const CHECKOUT = ["/checkout", "Checkout"];
const CONFIRMED = ["/order/confirmed", "Order confirmed"];
const BAG = ["/bag", "Bag"];
const ACCOUNT = ["/account", "Account"];

const FUNNEL = [HOME, SHOP, PRODUCT, CHECKOUT, CONFIRMED];

// How many core sessions reach each depth (inclusive). Sums to 1000.
const CORE = [
  [1, 280], // Home only
  [2, 220], // ... Shop
  [3, 260], // ... Product
  [4, 100], // ... Checkout
  [5, 140], // ... Order confirmed (converted)
];

function buildSessions() {
  const sessions = [];
  for (const [depth, count] of CORE) {
    for (let i = 0; i < count; i++) sessions.push(FUNNEL.slice(0, depth));
  }
  // Side traffic (all real Crate Atlas edges):
  for (let i = 0; i < 130; i++) sessions.push([HOME, BAG]); // storefront -> shopping_bag
  for (let i = 0; i < 70; i++) sessions.push([HOME, SHOP, PRODUCT, ACCOUNT]); // product_detail -> account_hub
  return sessions;
}

async function runSession(steps) {
  const c = new AtlasClient({
    apiKey: API_KEY,
    atlasAppId: ATLAS_APP_ID,
    host: HOST,
    flushAt: 1000, // don't auto-flush mid-session; shutdown() does the send
    flushInterval: 3600000,
  });
  for (const [key, title] of steps) c.trackScreen(key, { title });
  await c.shutdown(); // final flush + clears the interval timer (no leak)
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
          distinct_id: "atlas_dropoff_preflight",
          timestamp: new Date().toISOString(),
          properties: {
            screen: "/",
            $screen_name: "/",
            atlas_app_id: ATLAS_APP_ID,
            sdk: "atlas-analytics-rn",
            sdk_version: "0.1.0",
            _preflight: true,
          },
        },
      ],
    }),
  });
  const text = await res.text();
  console.log(`preflight POST /batch/ -> HTTP ${res.status} ${text.slice(0, 120)}`);
  if (!res.ok) throw new Error(`preflight failed (HTTP ${res.status}) — check the API key`);
}

async function main() {
  await preflight();
  const sessions = buildSessions();
  console.log(`seeding ${sessions.length} sessions across the Crate checkout funnel...`);
  let done = 0;
  let failed = 0;
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    const batch = sessions.slice(i, i + CONCURRENCY);
    const res = await Promise.allSettled(batch.map(runSession));
    for (const r of res) r.status === "fulfilled" ? done++ : failed++;
    process.stdout.write(`\r  ${done}/${sessions.length} sessions sent (${failed} failed)`);
  }
  console.log(`\nseed complete: ${done} sessions, ${failed} failed`);

  // Expected distinct-user counts (for verifying the query later):
  const expect = {
    "/ (storefront_home_feed)": 1200,
    "/collection (product_listing_collection)": 790,
    "/product/[id] (product_detail)": 570,
    "/checkout (checkout_form)": 240,
    "/order/confirmed (order_confirmation)": 140,
    "/bag (shopping_bag)": 130,
    "/account (account_hub)": 70,
  };
  console.log("expected distinct users per screen:");
  for (const [k, v] of Object.entries(expect)) console.log(`  ${v.toString().padStart(5)}  ${k}`);
}

main().catch((e) => {
  console.error("seed error:", e.message);
  process.exit(1);
});
