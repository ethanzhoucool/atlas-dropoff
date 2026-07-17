"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TEST_CONFIG,
  fakeFetch,
  loadFresh,
  setExpoRouterStub,
} = require("./helpers.cjs");

// Note: the react stub in helpers runs useEffect immediately, so calling the
// tracking hook exercises the real key-building + trackScreen path.

test("expo-router auto tracking keys by route pattern from useSegments (groups dropped)", async () => {
  let segments = ["(tabs)", "product", "[id]"];
  setExpoRouterStub({
    useSegments: () => segments,
    // Must be IGNORED when useSegments exists — concrete paths would
    // splinter the join key.
    usePathname: () => "/product/42",
  });
  const { sdk } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const client = sdk.initAtlasAnalytics(TEST_CONFIG);
  try {
    assert.equal(sdk.isExpoRouterAvailable(), true);

    sdk.useAtlasExpoRouterTracking(); // → /product/[id] (pattern, not /product/42)
    segments = ["(tabs)"];
    sdk.useAtlasExpoRouterTracking(); // only group segments → "/"
    segments = [];
    sdk.useAtlasExpoRouterTracking(); // root → "/" (deduped with previous)
    segments = ["checkout"];
    sdk.useAtlasExpoRouterTracking(); // → /checkout

    await sdk.flush();
    const batch = calls[0].body.batch;
    assert.deepEqual(
      batch.map((e) => e.properties.screen),
      ["/product/[id]", "/", "/checkout"]
    );
    assert.deepEqual(
      batch.map((e) => e.properties.prev_screen),
      [null, "/product/[id]", "/"]
    );
  } finally {
    await client.shutdown();
  }
});

test("falls back to usePathname when useSegments is unavailable, and normalizeScreen still applies", async () => {
  setExpoRouterStub({ usePathname: () => "/legacy/42" });
  const { sdk } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const client = sdk.initAtlasAnalytics({
    ...TEST_CONFIG,
    // The escape hatch covers the concrete-path fallback too.
    normalizeScreen: (s) => s.replace(/^\/legacy\/\d+$/, "/legacy/[id]"),
  });
  try {
    assert.equal(sdk.isExpoRouterAvailable(), true);
    sdk.useAtlasExpoRouterTracking();
    await sdk.flush();
    assert.deepEqual(
      calls[0].body.batch.map((e) => e.properties.screen),
      ["/legacy/[id]"]
    );
  } finally {
    await client.shutdown();
  }
});
