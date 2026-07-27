/**
 * Drive the Crate checkout funnel through the REAL @revyl/atlas-analytics
 * client into Amplitude AND Mixpanel at once (both pointed at
 * demo/mock-vendors.cjs), so the non-PostHog paths get the same end-to-end
 * treatment as the PostHog demo.
 *
 *   node demo/mock-vendors.cjs 8790 &
 *   node demo/seed-vendors.cjs http://localhost:8790
 *
 * Same journeys as seed-crate.cjs, so the report should land on the same
 * numbers the committed PostHog demo did: 1,201 entered, 11.7% converted,
 * biggest leak Product → Checkout −58%.
 *
 * The only shim is `react-native` (AppState); event shape, batching, identity
 * and transport are the shipped SDK code, unmodified.
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

const HOST = process.argv[2] || "http://localhost:8790";
const ATLAS_APP_ID = "cda16afc-2b9c-4042-a0c2-d863dc3c9ec6"; // Crate
const CONCURRENCY = 25;

const HOME = ["/", "Home"];
const SHOP = ["/collection", "Shop"];
const PRODUCT = ["/product/[id]", "Product"];
const CHECKOUT = ["/checkout", "Checkout"];
const CONFIRMED = ["/order/confirmed", "Order confirmed"];
const BAG = ["/bag", "Bag"];
const ACCOUNT = ["/account", "Account"];

const FUNNEL = [HOME, SHOP, PRODUCT, CHECKOUT, CONFIRMED];

/** The exact depth profile seed-crate.cjs sent to PostHog. Sums to 1000. */
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
  for (let i = 0; i < 130; i++) sessions.push([HOME, BAG]);
  for (let i = 0; i < 70; i++) sessions.push([HOME, SHOP, PRODUCT, ACCOUNT]);
  return sessions;
}

async function runSession(steps) {
  // One client per session → its own install id → one distinct user.
  const c = new AtlasClient({
    atlasAppId: ATLAS_APP_ID,
    amplitude: { apiKey: "amp_demo_key", host: HOST },
    mixpanel: { token: "mp_demo_token", host: HOST },
    flushAt: 1000, // shutdown() does the send
    flushInterval: 3600000,
  });
  for (const [key, title] of steps) c.trackScreen(key, { title });
  await c.shutdown();
}

async function main() {
  const stats = await fetch(`${HOST}/_stats`).then(
    (r) => r.json(),
    () => null
  );
  if (!stats) {
    throw new Error(`mock vendors not reachable at ${HOST} — start demo/mock-vendors.cjs first`);
  }

  const sessions = buildSessions();
  console.log(`seeding ${sessions.length} sessions → Amplitude + Mixpanel at ${HOST}`);
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    await Promise.all(sessions.slice(i, i + CONCURRENCY).map(runSession));
    if (i % 250 === 0) process.stdout.write(`  ${i}/${sessions.length}\r`);
  }
  const after = await fetch(`${HOST}/_stats`).then((r) => r.json());
  console.log(`\ndone — ${JSON.stringify(after)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
