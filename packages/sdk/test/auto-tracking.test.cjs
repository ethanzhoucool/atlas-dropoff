"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TEST_CONFIG, fakeFetch, loadFresh } = require("./helpers.cjs");

test("normalizeScreen applies on the React Navigation auto path (shared client)", async () => {
  const { sdk } = loadFresh();
  const { calls } = fakeFetch([{ status: 200 }]);
  const client = sdk.initAtlasAnalytics({
    ...TEST_CONFIG,
    normalizeScreen: (s) => s.replace(/^Product:\d+$/, "Product"),
  });
  try {
    const ref = { getCurrentRoute: () => ({ name: "Product:42" }) };
    sdk.onNavigationStateChange(ref); // auto path → getClient().trackScreen()
    ref.getCurrentRoute = () => ({ name: "Product:77" });
    sdk.onNavigationStateChange(ref); // normalizes to the same key → deduped
    ref.getCurrentRoute = () => ({ name: "Cart" });
    sdk.onNavigationStateChange(ref);

    await sdk.flush();
    const batch = calls[0].body.batch;
    assert.deepEqual(
      batch.map((e) => e.properties.screen),
      ["Product", "Cart"]
    );
    assert.equal(batch[1].properties.prev_screen, "Product");
  } finally {
    await client.shutdown();
  }
});
