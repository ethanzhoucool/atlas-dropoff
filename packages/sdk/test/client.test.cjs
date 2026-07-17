"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TEST_CONFIG, fakeFetch, loadFresh, settle } = require("./helpers.cjs");

function newClient(AtlasClient, overrides = {}) {
  return new AtlasClient({ ...TEST_CONFIG, ...overrides });
}

test("harness sanity: compiled SDK loads under Node with react-native stubbed", () => {
  const { sdk, client } = loadFresh();
  assert.equal(typeof client.AtlasClient, "function");
  assert.equal(typeof sdk.initAtlasAnalytics, "function");
  assert.equal(typeof sdk.trackScreen, "function");
});

test("dedupes consecutive screens and chains prev_screen", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient);
  try {
    c.trackScreen("/a");
    c.trackScreen("/a"); // consecutive duplicate — dropped
    c.trackScreen("/b");
    c.trackScreen("/b"); // dropped
    c.trackScreen("/a"); // not consecutive — kept
    await c.flush();

    assert.equal(calls.length, 1);
    const batch = calls[0].body.batch;
    assert.deepEqual(
      batch.map((e) => e.event),
      ["atlas_screen", "atlas_screen", "atlas_screen"]
    );
    assert.deepEqual(
      batch.map((e) => e.properties.screen),
      ["/a", "/b", "/a"]
    );
    assert.deepEqual(
      batch.map((e) => e.properties.prev_screen),
      [null, "/a", "/b"]
    );
    // $screen_name mirrors screen; contract fields present.
    assert.deepEqual(
      batch.map((e) => e.properties.$screen_name),
      ["/a", "/b", "/a"]
    );
    assert.ok(batch.every((e) => e.properties.atlas_app_id === "atlas_test_app"));
    assert.ok(batch.every((e) => e.properties.sdk === "atlas-analytics-rn"));
  } finally {
    await c.shutdown();
  }
});

test("normalizeScreen collapses dynamic keys before dedupe (manual path)", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient, {
    normalizeScreen: (s) => s.replace(/^\/users\/\d+$/, "/users/[id]"),
  });
  try {
    c.trackScreen("/users/123");
    c.trackScreen("/users/456"); // same normalized key — deduped away
    c.trackScreen("/settings");
    await c.flush();

    const batch = calls[0].body.batch;
    assert.deepEqual(
      batch.map((e) => e.properties.screen),
      ["/users/[id]", "/settings"]
    );
    assert.equal(batch[0].properties.$screen_name, "/users/[id]");
    assert.equal(batch[1].properties.prev_screen, "/users/[id]");
  } finally {
    await c.shutdown();
  }
});

test("screenKeyOverride wins over the raw screen, then normalizeScreen applies to it", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient, {
    normalizeScreen: (s) => s.toLowerCase(),
  });
  try {
    c.trackScreen("/product/42", { screenKeyOverride: "/PRODUCT/[ID]" });
    await c.flush();

    const batch = calls[0].body.batch;
    assert.equal(batch.length, 1);
    // Override took precedence over "/product/42", normalize ran on the override.
    assert.equal(batch[0].properties.screen, "/product/[id]");
  } finally {
    await c.shutdown();
  }
});

test("identify() stamps events synchronously and emits $identify with $anon_distinct_id", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient);
  try {
    await settle(); // let the install id finish loading

    c.identify("user_1");
    c.trackScreen("/after-login");
    // Synchronous stamp: the queued event already carries the user id at
    // enqueue time (before any flush-time restamp could run).
    const queued = c.queue.find((e) => e.event === "atlas_screen");
    assert.equal(queued.distinct_id, "user_1");

    await c.flush();
    const batch = calls[0].body.batch;

    const identifyEvt = batch.find((e) => e.event === "$identify");
    assert.ok(identifyEvt, "expected a $identify event");
    assert.equal(identifyEvt.distinct_id, "user_1");
    const anon = identifyEvt.properties.$anon_distinct_id;
    assert.equal(typeof anon, "string");
    assert.ok(anon.length > 0);
    assert.notEqual(anon, "user_1"); // it's the anonymous install id

    const screenEvt = batch.find((e) => e.event === "atlas_screen");
    assert.equal(screenEvt.distinct_id, "user_1");
  } finally {
    await c.shutdown();
  }
});

test("reset() rotates session, clears prev_screen chain, and restores the anon id", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient);
  try {
    await settle();
    c.identify("user_9");
    c.trackScreen("/home");
    await c.flush();
    const first = calls[0].body.batch;
    const installId = first.find((e) => e.event === "$identify").properties
      .$anon_distinct_id;
    const beforeScreen = first.find((e) => e.event === "atlas_screen");

    c.reset();
    c.trackScreen("/home"); // same key as pre-reset — must NOT be deduped
    await c.flush();

    assert.equal(calls.length, 2);
    const after = calls[1].body.batch[0];
    assert.equal(after.event, "atlas_screen");
    assert.equal(after.properties.prev_screen, null); // fresh chain
    assert.notEqual(after.properties.session_id, beforeScreen.properties.session_id);
    assert.notEqual(after.distinct_id, "user_9");
    assert.equal(after.distinct_id, installId); // back to the anon install id
  } finally {
    await c.shutdown();
  }
});

test("reset() before identity finishes loading never stamps the stale user id", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient);
  try {
    // No settle(): installId is still loading for all three calls below.
    c.identify("user_stale");
    c.reset();
    c.trackScreen("/fresh");

    // The queued event must not carry the stale identified id — pre-fix,
    // reset() kept distinctId = "user_stale" while installId was undefined.
    const queued = c.queue.find((e) => e.event === "atlas_screen");
    assert.notEqual(queued.distinct_id, "user_stale");

    await c.flush();
    const screenEvt = calls[0].body.batch.find((e) => e.event === "atlas_screen");
    assert.notEqual(screenEvt.distinct_id, "user_stale");
    // Flush-time restamp filled in the (by-then loaded) install id.
    assert.match(screenEvt.distinct_id, /^[0-9a-f-]{36}$/);
  } finally {
    await c.shutdown();
  }
});

test("requeues on HTTP 500 and redelivers on the next flush", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 500 }, { status: 200 }]);
  const c = newClient(client.AtlasClient);
  try {
    c.trackScreen("/a");
    await c.flush(); // 500 → requeued
    assert.equal(calls.length, 1);

    await c.flush(); // 200 → delivered
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls[1].body.batch.map((e) => e.properties.screen),
      ["/a"]
    );

    await c.flush(); // queue is empty — no extra request
    assert.equal(calls.length, 2);
  } finally {
    await c.shutdown();
  }
});

test("drops the batch on HTTP 400 (no retry loop)", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 400 }]);
  const c = newClient(client.AtlasClient);
  try {
    c.trackScreen("/a");
    await c.flush(); // 400 → dropped
    assert.equal(calls.length, 1);

    await c.flush(); // nothing left to send
    assert.equal(calls.length, 1);
  } finally {
    await c.shutdown();
  }
});

test("aborts a hung request after requestTimeout, requeues, and keeps delivering", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ hang: true }, { status: 200 }]);
  const c = newClient(client.AtlasClient, { requestTimeout: 100 });
  try {
    c.trackScreen("/slow");
    const t0 = Date.now();
    await c.flush(); // must settle via abort → catch → requeue, not hang
    assert.ok(Date.now() - t0 < 5000, "flush() should settle after the abort");
    assert.equal(calls.length, 1);

    // `flushing` must have been released and the events kept:
    await c.flush();
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls[1].body.batch.map((e) => e.properties.screen),
      ["/slow"]
    );
  } finally {
    await c.shutdown();
  }
});
