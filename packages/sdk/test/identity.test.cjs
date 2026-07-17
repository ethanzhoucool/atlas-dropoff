"use strict";

/**
 * Async-identity correctness: rapid identify() calls, reset()+identify()
 * ordering, identify-then-flush, and same-id $set updates.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { TEST_CONFIG, fakeFetch, loadFresh, settle } = require("./helpers.cjs");

const UUID_RE = /^[0-9a-f-]{36}$/;

function newClient(AtlasClient, overrides = {}) {
  return new AtlasClient({ ...TEST_CONFIG, ...overrides });
}

test("rapid identify() calls each emit a correct, frozen $identify", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient);
  try {
    await settle(); // let the install id finish loading

    c.identify("user_A", { name: "A" });
    c.identify("user_B", { name: "B" });
    await c.flush();

    assert.equal(calls.length, 1);
    const identifies = calls[0].body.batch.filter((e) => e.event === "$identify");
    assert.equal(identifies.length, 2, "expected exactly two $identify events");

    const [a, b] = identifies;
    // First transition: install id → user_A, with A's props. Pre-fix, this
    // event was stamped user_B and A's $set landed on B.
    assert.equal(a.distinct_id, "user_A");
    assert.deepEqual(a.properties.$set, { name: "A" });
    assert.match(a.properties.$anon_distinct_id, UUID_RE);
    assert.notEqual(a.properties.$anon_distinct_id, "user_A");

    // Second transition: user_A → user_B, with B's props.
    assert.equal(b.distinct_id, "user_B");
    assert.deepEqual(b.properties.$set, { name: "B" });
    assert.equal(b.properties.$anon_distinct_id, "user_A");
  } finally {
    await c.shutdown();
  }
});

test("identify() then immediate flush() delivers the pending $identify", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient);
  try {
    // No settle(), nothing else queued: the $identify is still pending in the
    // identity chain when flush() is called. Pre-fix, flush() saw an empty
    // queue and no-oped.
    c.identify("u");
    await c.flush();

    assert.equal(calls.length, 1, "flush() must deliver the pending $identify");
    const batch = calls[0].body.batch;
    assert.equal(batch.length, 1);
    assert.equal(batch[0].event, "$identify");
    assert.equal(batch[0].distinct_id, "u");
    // Anonymous history merges even though identify() beat the id load.
    assert.match(batch[0].properties.$anon_distinct_id, UUID_RE);
  } finally {
    await c.shutdown();
  }
});

test("reset() then identify() stamps later events with the new user, not the install id", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient);
  try {
    await settle();
    const installId = c.installId;
    assert.match(installId, UUID_RE);

    c.reset();
    c.identify("user_B");
    c.trackScreen("/x");
    await c.flush();

    const batch = calls[0].body.batch;
    const identifyEvt = batch.find((e) => e.event === "$identify");
    const screenEvt = batch.find((e) => e.event === "atlas_screen");
    assert.ok(identifyEvt, "expected a $identify event");
    assert.ok(screenEvt, "expected the tracked screen event");
    // Pre-fix, reset()'s chained op ran after identify() and clobbered the
    // identity back to the install id.
    assert.equal(identifyEvt.distinct_id, "user_B");
    assert.equal(screenEvt.distinct_id, "user_B");
    assert.notEqual(screenEvt.distinct_id, installId);
    assert.equal(identifyEvt.properties.$anon_distinct_id, installId);
  } finally {
    await c.shutdown();
  }
});

test("identify(sameId, props) still sends the $set update", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient);
  try {
    await settle();

    c.identify("u");
    c.identify("u", { plan: "pro" }); // same id — pre-fix this was dropped
    await c.flush();

    const identifies = calls[0].body.batch.filter((e) => e.event === "$identify");
    assert.equal(identifies.length, 2);
    const update = identifies[1];
    assert.equal(update.distinct_id, "u");
    assert.deepEqual(update.properties.$set, { plan: "pro" });
    // No merge on a same-id props update.
    assert.equal("$anon_distinct_id" in update.properties, false);

    // Same id with NO props stays a true no-op.
    c.identify("u");
    await c.flush();
    assert.equal(calls.length, 1);
  } finally {
    await c.shutdown();
  }
});
