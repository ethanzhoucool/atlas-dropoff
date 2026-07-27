"use strict";

/**
 * Destination payload mapping + multi-destination fan-out.
 *
 * The canonical event is vendor-neutral; these tests pin the exact envelope
 * each vendor receives, because a wrong field name there is invisible at
 * runtime (the event just quietly doesn't join in the report).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFetch, loadFresh, settle } = require("./helpers.cjs");

const BASE = {
  atlasAppId: "atlas_test_app",
  flushAt: 1000, // never auto-flush mid-test
  flushInterval: 3600000,
};

function newClient(AtlasClient, overrides) {
  return new AtlasClient({ ...BASE, ...overrides });
}

/* ── PostHog ────────────────────────────────────────────────── */

test("legacy apiKey/host still resolve to the PostHog destination", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient, {
    apiKey: "phc_legacy",
    host: "https://posthog.test",
  });
  try {
    assert.deepEqual(c.destinationNames, ["posthog"]);
    c.trackScreen("/a");
    await c.flush();

    assert.equal(calls[0].url, "https://posthog.test/batch/");
    assert.equal(calls[0].body.api_key, "phc_legacy");
    // uuid is the per-capture insert id: a retried batch dedupes.
    assert.match(calls[0].body.batch[0].uuid, /^[0-9a-f-]{36}$/);
  } finally {
    await c.shutdown();
  }
});

/* ── Amplitude ──────────────────────────────────────────────── */

test("amplitude payload: /2/httpapi envelope, ids, and $-props stripped", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient, { amplitude: { apiKey: "amp_key" } });
  try {
    await settle(); // install id loaded
    c.trackScreen("/checkout", { title: "Checkout" });
    await c.flush();

    assert.equal(calls[0].url, "https://api2.amplitude.com/2/httpapi");
    const body = calls[0].body;
    assert.equal(body.api_key, "amp_key");
    // Short app-supplied user ids must not be rejected by Amplitude's default.
    assert.equal(body.options.min_id_length, 1);

    const evt = body.events[0];
    assert.equal(evt.event_type, "atlas_screen");
    assert.equal(typeof evt.time, "number");
    assert.match(evt.insert_id, /^[0-9a-f-]{36}$/);
    assert.match(evt.device_id, /^[0-9a-f-]{36}$/);
    assert.equal(evt.user_id, undefined); // still anonymous
    assert.equal(typeof evt.session_id, "number"); // Amplitude sessions are numeric
    assert.equal(evt.event_properties.screen, "/checkout");
    assert.equal(evt.event_properties.screen_title, "Checkout");
    assert.equal(evt.event_properties.prev_screen, null);
    assert.equal(evt.event_properties.atlas_app_id, "atlas_test_app");
    assert.equal(typeof evt.event_properties.session_id, "string"); // the SDK's own
    // PostHog dialect never reaches Amplitude.
    assert.equal("$screen_name" in evt.event_properties, false);
  } finally {
    await c.shutdown();
  }
});

test("amplitude: identify() pairs device_id with user_id (that IS the merge)", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient, { amplitude: { apiKey: "amp_key" } });
  try {
    await settle();
    c.trackScreen("/login");
    c.identify("user_42", { plan: "pro" });
    c.trackScreen("/home");
    await c.flush();

    const httpapi = calls.find((call) => call.url.endsWith("/2/httpapi"));
    const events = httpapi.body.events;
    const before = events.find((e) => e.event_properties?.screen === "/login");
    const after = events.find((e) => e.event_properties?.screen === "/home");
    assert.equal(before.user_id, undefined);
    assert.equal(after.user_id, "user_42");
    // Same device across the boundary — Amplitude fuses the two histories.
    assert.equal(after.device_id, before.device_id);
    // $identify is never an event here: the merge is implicit.
    assert.equal(events.some((e) => e.event_type === "$identify"), false);

    // User properties go to the dedicated (form-encoded) Identify API.
    const identify = calls.find((call) => call.url.endsWith("/identify"));
    const form = new URLSearchParams(identify.options.body);
    assert.equal(
      identify.options.headers["Content-Type"],
      "application/x-www-form-urlencoded"
    );
    assert.equal(form.get("api_key"), "amp_key");
    const identification = JSON.parse(form.get("identification"));
    assert.equal(identification[0].user_id, "user_42");
    assert.deepEqual(identification[0].user_properties, { $set: { plan: "pro" } });
  } finally {
    await c.shutdown();
  }
});

test("amplitude: a $identify with no properties is dropped, not sent empty", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient, { amplitude: { apiKey: "amp_key" } });
  try {
    await settle();
    c.identify("user_7"); // no props → PostHog needs it, Amplitude does not
    await c.flush();
    // Nothing worth sending: no request at all.
    assert.equal(calls.length, 0);
  } finally {
    await c.shutdown();
  }
});

test("amplitude: region eu switches the host", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const c = newClient(client.AtlasClient, {
    amplitude: { apiKey: "amp_key" },
    region: "eu",
  });
  try {
    c.trackScreen("/a");
    await c.flush();
    assert.equal(calls[0].url, "https://api.eu.amplitude.com/2/httpapi");
  } finally {
    await c.shutdown();
  }
});

/* ── Mixpanel ───────────────────────────────────────────────── */

test("mixpanel payload: $device: prefix while anonymous, $user_id after identify", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200, text: "1" }]);
  const c = newClient(client.AtlasClient, { mixpanel: { token: "mp_token" } });
  try {
    await settle();
    c.trackScreen("/welcome");
    c.identify("user_9");
    c.trackScreen("/home");
    await c.flush();

    const track = calls.find((call) => call.url.endsWith("/track"));
    assert.equal(track.url, "https://api.mixpanel.com/track");
    assert.ok(Array.isArray(track.body), "body is a bare array of events");

    const anon = track.body.find((e) => e.properties.screen === "/welcome");
    assert.equal(anon.event, "atlas_screen");
    assert.equal(anon.properties.token, "mp_token");
    assert.match(anon.properties.distinct_id, /^\$device:[0-9a-f-]{36}$/);
    assert.equal(anon.properties.$user_id, undefined);
    assert.equal(typeof anon.properties.time, "number");
    assert.match(anon.properties.$insert_id, /^[0-9a-f-]{36}$/);
    assert.equal("$screen_name" in anon.properties, false);

    const identified = track.body.find((e) => e.properties.screen === "/home");
    assert.equal(identified.properties.distinct_id, "user_9");
    assert.equal(identified.properties.$user_id, "user_9");
    // Simplified ID merge needs both on the same event.
    assert.equal(identified.properties.$device_id, anon.properties.$device_id);
  } finally {
    await c.shutdown();
  }
});

test("mixpanel: identify props go to /engage as a profile $set", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200, text: "1" }]);
  const c = newClient(client.AtlasClient, { mixpanel: { token: "mp_token" } });
  try {
    await settle();
    c.identify("user_3", { plan: "pro" });
    c.trackScreen("/home");
    await c.flush();

    const engage = calls.find((call) => call.url.endsWith("/engage"));
    assert.ok(engage, "expected an /engage request");
    assert.deepEqual(engage.body, [
      { $token: "mp_token", $distinct_id: "user_3", $set: { plan: "pro" } },
    ]);
  } finally {
    await c.shutdown();
  }
});

test("mixpanel: HTTP 200 with body `0` is a permanent failure, not a retry", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200, text: "0" }]);
  const c = newClient(client.AtlasClient, { mixpanel: { token: "bad" } });
  try {
    c.trackScreen("/a");
    await c.flush();
    assert.equal(calls.length, 1);
    await c.flush(); // dropped, not requeued
    assert.equal(calls.length, 1);
  } finally {
    await c.shutdown();
  }
});

/* ── fan-out ────────────────────────────────────────────────── */

test("fans out one capture to every destination", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([{ status: 200, text: "1" }]);
  const c = newClient(client.AtlasClient, {
    posthog: { apiKey: "phc_x", host: "https://posthog.test" },
    amplitude: { apiKey: "amp_key" },
    mixpanel: { token: "mp_token" },
  });
  try {
    assert.deepEqual(c.destinationNames, ["posthog", "amplitude", "mixpanel"]);
    c.trackScreen("/a");
    await c.flush();

    const urls = calls.map((call) => call.url).sort();
    assert.deepEqual(urls, [
      "https://api.mixpanel.com/track",
      "https://api2.amplitude.com/2/httpapi",
      "https://posthog.test/batch/",
    ]);
  } finally {
    await c.shutdown();
  }
});

test("a failing destination requeues only for itself", async () => {
  const { client } = loadFresh();
  const { calls } = fakeFetch([
    { url: "posthog\\.test", status: 200 },
    { url: "amplitude", status: 500 },
    { url: "amplitude", status: 200 },
  ]);
  const c = newClient(client.AtlasClient, {
    posthog: { apiKey: "phc_x", host: "https://posthog.test" },
    amplitude: { apiKey: "amp_key" },
  });
  try {
    c.trackScreen("/a");
    await c.flush(); // PostHog 200, Amplitude 500
    assert.equal(calls.length, 2);

    await c.flush(); // only Amplitude retries
    assert.equal(calls.length, 3);
    assert.match(calls[2].url, /amplitude/);
    assert.equal(calls[2].body.events[0].event_properties.screen, "/a");

    await c.flush(); // both clear now
    assert.equal(calls.length, 3);
  } finally {
    await c.shutdown();
  }
});

/* ── custom transport ───────────────────────────────────────── */

test("customDestination receives the canonical batch; a throw requeues it", async () => {
  const { sdk, client } = loadFresh();
  fakeFetch([{ status: 200 }]);
  const seen = [];
  let failNext = true;
  const c = newClient(client.AtlasClient, {
    destinations: [
      sdk.customDestination({
        name: "warehouse",
        async send(batch) {
          if (failNext) {
            failNext = false;
            throw new Error("collector down");
          }
          seen.push(batch);
        },
      }),
    ],
  });
  try {
    assert.deepEqual(c.destinationNames, ["warehouse"]);
    c.trackScreen("/a");
    await c.flush(); // throws → requeued
    assert.equal(seen.length, 0);

    await c.flush(); // delivered
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0].properties.screen, "/a");
    assert.equal(seen[0][0].event, "atlas_screen");
    assert.equal(typeof seen[0][0].device_id, "string");
    assert.equal(seen[0][0].user_id, null);
  } finally {
    await c.shutdown();
  }
});
