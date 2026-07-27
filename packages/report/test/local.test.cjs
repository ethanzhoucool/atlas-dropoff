"use strict";

/**
 * The local aggregation engine: distinct-user counts and the sequential
 * funnel, computed in-process from raw events.
 *
 * These are the numbers that a wrong implementation would silently make
 * plausible-but-false, so they're pinned against hand-counted fixtures.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
// dist/ is ESM; the test files are CJS (same pattern as funnel.test.cjs).
const localP = import("../dist/sources/local.js");

/** Build an accumulator from [user, screen, prev, tSeconds] tuples.
    Fixture times are written in seconds and scaled to the engine's
    millisecond unit here, so they stay readable. */
async function accumulate(rows) {
  const { EventAccumulator } = await localP;
  const acc = new EventAccumulator();
  for (const [user, screen, prevScreen, timeSec] of rows) {
    acc.add({ user, screen, prevScreen, timeMs: timeSec * 1000 });
  }
  return acc;
}

test("counts distinct users per screen, not raw events", async () => {
  const acc = await accumulate([
    ["u1", "/home", null, 100],
    ["u1", "/home", "/cart", 300], // same user, second view
    ["u1", "/cart", "/home", 200],
    ["u2", "/home", null, 100],
  ]);
  const counts = acc.toCounts("events-file");

  assert.equal(counts.screens["/home"].users, 2);
  assert.equal(counts.screens["/home"].events, 3); // raw views ARE additive
  assert.equal(counts.screens["/cart"].users, 1);
});

test("a user who takes the same transition twice counts once", async () => {
  const acc = await accumulate([
    ["u1", "/cart", "/home", 100],
    ["u1", "/cart", "/home", 200],
    ["u2", "/cart", "/home", 100],
  ]);
  const counts = acc.toCounts("events-file");
  const t = counts.transitions.find((x) => x.src === "/home" && x.dst === "/cart");
  assert.equal(t.users, 2);
});

test("leavers count users who left a screen once, not once per destination", async () => {
  // u1 leaves /home to two different screens — the naive per-destination sum
  // would say 2 leavers and push the exit rate to 0.
  const acc = await accumulate([
    ["u1", "/a", "/home", 100],
    ["u1", "/b", "/home", 200],
    ["u2", "/a", "/home", 100],
  ]);
  const counts = acc.toCounts("events-file");
  assert.equal(counts.leavers["/home"], 2);
});

test("sequential funnel counts only in-order completions", async () => {
  const acc = await accumulate([
    // u1 walks the whole path in order.
    ["u1", "/a", null, 10],
    ["u1", "/b", "/a", 20],
    ["u1", "/c", "/b", 30],
    // u2 stops at step 2.
    ["u2", "/a", null, 10],
    ["u2", "/b", "/a", 20],
    // u3 sees /c first, then /a — that is NOT a completion.
    ["u3", "/c", null, 10],
    ["u3", "/a", "/c", 20],
  ]);
  assert.deepEqual(acc.funnel([["/a"], ["/b"], ["/c"]], 86400), [3, 2, 1]);
});

test("sequential funnel enforces the conversion window", async () => {
  const acc = await accumulate([
    ["u1", "/a", null, 0],
    ["u1", "/b", "/a", 60], // inside a 120s window
    ["u2", "/a", null, 0],
    ["u2", "/b", "/a", 5000], // way outside it
  ]);
  assert.deepEqual(acc.funnel([["/a"], ["/b"]], 120), [2, 1]);
  assert.deepEqual(acc.funnel([["/a"], ["/b"]], 86400), [2, 2]);
});

test("a restarted attempt still converts if the second run fits the window", async () => {
  // First attempt stalls; the user comes back an hour later and completes.
  const acc = await accumulate([
    ["u1", "/a", null, 0],
    ["u1", "/a", "/x", 3600],
    ["u1", "/b", "/a", 3630],
  ]);
  assert.deepEqual(acc.funnel([["/a"], ["/b"]], 120), [1, 1]);
});

test("a step matches any of its node's aliases, and the user counts once", async () => {
  const acc = await accumulate([
    ["u1", "/checkout", null, 10],
    ["u1", "/checkout-v2", "/checkout", 20], // both map to one Atlas node
    ["u1", "/done", "/checkout-v2", 30],
  ]);
  assert.deepEqual(
    acc.funnel([["/checkout", "/checkout-v2"], ["/done"]], 86400),
    [1, 1]
  );
});

test("the funnel cohort is monotone non-increasing", async () => {
  const acc = await accumulate([
    ["u1", "/a", null, 10],
    ["u1", "/b", "/a", 20],
    ["u2", "/b", null, 10], // saw step 2 without step 1
    ["u3", "/b", null, 10],
  ]);
  const cohort = acc.funnel([["/a"], ["/b"]], 86400);
  assert.deepEqual(cohort, [1, 1]);
  for (let i = 1; i < cohort.length; i++) {
    assert.ok(cohort[i] <= cohort[i - 1]);
  }
});

test("out-of-order input is sorted by time before anything is computed", async () => {
  const acc = await accumulate([
    ["u1", "/c", "/b", 30],
    ["u1", "/a", null, 10],
    ["u1", "/b", "/a", 20],
  ]);
  assert.deepEqual(acc.funnel([["/a"], ["/b"], ["/c"]], 86400), [1, 1, 1]);
});

test("a step whose keys never appear zeroes the rest of the funnel", async () => {
  const acc = await accumulate([["u1", "/a", null, 10]]);
  assert.deepEqual(acc.funnel([["/a"], ["/never-seen"]], 86400), [1, 0]);
});

/* ── line parsing ───────────────────────────────────────────── */

test("parseEventLine reads the vendor export envelope", async () => {
  const { parseEventLine } = await localP;
  const line = JSON.stringify({
    event: "atlas_screen",
    properties: {
      screen: "/home",
      prev_screen: null,
      distinct_id: "u1",
      atlas_app_id: "app-1",
      time: 1750000000,
    },
  });
  assert.deepEqual(parseEventLine(line), {
    user: "u1",
    screen: "/home",
    prevScreen: null,
    timeMs: 1750000000000, // seconds in, milliseconds out
    // No device/user pair on this row — nothing to stitch.
    deviceId: undefined,
    userId: undefined,
  });
});

test("parseEventLine reads a flat row and falls back through the id fields", async () => {
  const { parseEventLine } = await localP;
  const line = JSON.stringify({
    screen: "/cart",
    prev_screen: "/home",
    $device_id: "dev-9",
    timestamp: "2026-07-27T00:00:00.000Z",
  });
  const parsed = parseEventLine(line);
  assert.equal(parsed.user, "dev-9");
  assert.equal(parsed.prevScreen, "/home");
  assert.equal(parsed.timeMs, Date.parse("2026-07-27T00:00:00Z"));
});

test("parseEventLine filters other events and other apps", async () => {
  const { parseEventLine } = await localP;
  const other = JSON.stringify({
    event: "purchase",
    properties: { screen: "/home", distinct_id: "u1" },
  });
  assert.equal(parseEventLine(other), null);

  const otherApp = JSON.stringify({
    event: "atlas_screen",
    properties: { screen: "/home", distinct_id: "u1", atlas_app_id: "other" },
  });
  assert.equal(parseEventLine(otherApp, { appId: "mine" }), null);
  assert.ok(parseEventLine(otherApp, { appId: "other" }));
});

test("parseEventLine survives junk lines instead of throwing", async () => {
  const { parseEventLine } = await localP;
  assert.equal(parseEventLine(""), null);
  assert.equal(parseEventLine("   "), null);
  assert.equal(parseEventLine("{not json"), null);
  assert.equal(parseEventLine("[1,2,3]"), null);
  // A row with no screen, or no user, carries no signal.
  assert.equal(parseEventLine(JSON.stringify({ distinct_id: "u1" })), null);
  assert.equal(parseEventLine(JSON.stringify({ screen: "/a" })), null);
});

test("parseTime normalizes seconds, milliseconds and ISO strings to ms", async () => {
  const { parseTime } = await localP;
  assert.equal(parseTime(1750000000), 1750000000000); // bare seconds
  assert.equal(parseTime(1750000000000), 1750000000000); // already ms
  assert.equal(parseTime("2026-07-27T00:00:00Z"), 1785110400000);
  assert.equal(parseTime(undefined), 0);
});

/* ── identity stitching ─────────────────────────────────────── */

test("an event carrying both ids folds the pre-login timeline into the user", async () => {
  const { EventAccumulator } = await localP;
  const acc = new EventAccumulator();
  // Anonymous browsing, then login, then the rest of the funnel — exactly what
  // an onboarding funnel looks like. Without stitching this is two "users" and
  // conversion reads 0%.
  acc.add({ user: "$device:dev-1", screen: "/welcome", prevScreen: null, timeMs: 10_000, deviceId: "dev-1" });
  acc.add({ user: "$device:dev-1", screen: "/signup", prevScreen: "/welcome", timeMs: 20_000, deviceId: "dev-1" });
  acc.add({ user: "u_9", screen: "/home", prevScreen: "/signup", timeMs: 30_000, deviceId: "dev-1", userId: "u_9" });

  const counts = acc.toCounts("events-file");
  assert.equal(counts.screens["/welcome"].users, 1);
  assert.equal(counts.screens["/home"].users, 1);
  // One person walked the whole path.
  assert.deepEqual(acc.funnel([["/welcome"], ["/signup"], ["/home"]], 86400), [1, 1, 1]);
});

test("stitching also works when the identified events arrive first", async () => {
  const { EventAccumulator } = await localP;
  const acc = new EventAccumulator();
  acc.add({ user: "u_9", screen: "/home", prevScreen: "/signup", timeMs: 30_000, deviceId: "dev-1", userId: "u_9" });
  acc.add({ user: "$device:dev-1", screen: "/welcome", prevScreen: null, timeMs: 10_000, deviceId: "dev-1" });
  assert.deepEqual(acc.funnel([["/welcome"], ["/home"]], 86400), [1, 1]);
});

test("two devices belonging to the same user collapse to one person", async () => {
  const { EventAccumulator } = await localP;
  const acc = new EventAccumulator();
  acc.add({ user: "phone", screen: "/a", prevScreen: null, timeMs: 10_000, deviceId: "phone" });
  acc.add({ user: "tablet", screen: "/a", prevScreen: null, timeMs: 20_000, deviceId: "tablet" });
  acc.add({ user: "u_1", screen: "/b", prevScreen: "/a", timeMs: 30_000, deviceId: "phone", userId: "u_1" });
  acc.add({ user: "u_1", screen: "/b", prevScreen: "/a", timeMs: 40_000, deviceId: "tablet", userId: "u_1" });
  const counts = acc.toCounts("events-file");
  assert.equal(counts.screens["/a"].users, 1);
  assert.equal(counts.screens["/a"].events, 2);
});

test("unrelated anonymous users are never merged", async () => {
  const { EventAccumulator } = await localP;
  const acc = new EventAccumulator();
  acc.add({ user: "$device:dev-1", screen: "/a", prevScreen: null, timeMs: 10_000, deviceId: "dev-1" });
  acc.add({ user: "$device:dev-2", screen: "/a", prevScreen: null, timeMs: 10_000, deviceId: "dev-2" });
  acc.add({ user: "u_9", screen: "/b", prevScreen: "/a", timeMs: 20_000, deviceId: "dev-1", userId: "u_9" });
  const counts = acc.toCounts("events-file");
  assert.equal(counts.screens["/a"].users, 2); // dev-2 is still its own person
});

test("parseEventLine surfaces the device/user pair for stitching", async () => {
  const { parseEventLine } = await localP;
  const line = JSON.stringify({
    event: "atlas_screen",
    properties: {
      screen: "/home",
      prev_screen: "/signup",
      distinct_id: "u_9",
      $device_id: "dev-1",
      $user_id: "u_9",
      time: 100,
    },
  });
  const parsed = parseEventLine(line);
  assert.equal(parsed.user, "u_9");
  assert.equal(parsed.deviceId, "dev-1");
  assert.equal(parsed.userId, "u_9");
});

test("parseEventLine reads identity off the envelope when only `screen` is nested", async () => {
  const { parseEventLine } = await localP;
  // The SDK's own canonical event, i.e. what a customDestination hands to a
  // warehouse: contract fields inside `properties`, identity outside. Reading
  // only `properties` made every such line look user-less and skipped the file.
  const line = JSON.stringify({
    event: "atlas_screen",
    distinct_id: "u_9",
    device_id: "dev-1",
    user_id: "u_9",
    insert_id: "abc",
    timestamp: "2026-07-27T00:00:00.000Z",
    properties: { screen: "/home", prev_screen: "/welcome", atlas_app_id: "app-1" },
  });
  const parsed = parseEventLine(line, { appId: "app-1" });
  assert.equal(parsed.user, "u_9");
  assert.equal(parsed.screen, "/home");
  assert.equal(parsed.prevScreen, "/welcome");
  assert.equal(parsed.deviceId, "dev-1");
  assert.equal(parsed.timeMs, Date.parse("2026-07-27T00:00:00Z"));
});

test("nested properties still win over the envelope for the same key", async () => {
  const { parseEventLine } = await localP;
  const line = JSON.stringify({
    event: "atlas_screen",
    distinct_id: "envelope",
    properties: { screen: "/a", distinct_id: "nested" },
  });
  assert.equal(parseEventLine(line).user, "nested");
});
