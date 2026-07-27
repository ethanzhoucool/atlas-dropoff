"use strict";

/**
 * Test harness for the compiled SDK (dist/, CJS) under plain Node.
 *
 * Node has no react-native, so the peer modules are stubbed with the same
 * Module._load override pattern as demo/seed-crate.cjs. Requiring this file
 * installs the stubs; loadFresh() then requires dist/ with a clean module
 * cache so each test file gets its own shared-client singleton.
 */

const path = require("path");
const Module = require("module");

const DIST_DIR = path.join(__dirname, "..", "dist") + path.sep;

// --- react-native stub: the client only uses AppState -----------------------
const appStateListeners = [];
const reactNativeStub = {
  AppState: {
    addEventListener(_type, listener) {
      appStateListeners.push(listener);
      return {
        remove() {
          const i = appStateListeners.indexOf(listener);
          if (i !== -1) appStateListeners.splice(i, 1);
        },
      };
    },
  },
};

/** Simulate an AppState transition (drives the client's background flush). */
function emitAppState(state) {
  for (const listener of [...appStateListeners]) {
    listener(state);
  }
}

// --- react stub: just enough for dist/provider.js + the tracking hooks ------
const reactStub = {
  createContext: (defaultValue) => ({
    Provider: {},
    Consumer: {},
    _default: defaultValue,
  }),
  useContext: (ctx) => ctx._default,
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  // Runs the effect immediately — enough to exercise the tracking hooks
  // synchronously in tests (the client dedupes repeats anyway).
  useEffect: (effect) => {
    effect();
  },
  createElement: (type, props, ...children) => ({ type, props, children }),
  Component: class Component {
    constructor(props) {
      this.props = props;
    }
    setState(next) {
      this.state = { ...this.state, ...next };
    }
  },
};

// Set via setExpoRouterStub() BEFORE loadFresh(); null → require() falls
// through to Node resolution and throws MODULE_NOT_FOUND (the real behavior
// when expo-router isn't installed).
let expoRouterStub = null;
function setExpoRouterStub(stub) {
  expoRouterStub = stub;
}

const origLoad = Module._load;
Module._load = function (request) {
  if (request === "react-native") return reactNativeStub;
  if (request === "react") return reactStub;
  if (request === "expo-router" && expoRouterStub) return expoRouterStub;
  return origLoad.apply(this, arguments);
};

/**
 * Require the compiled SDK with a fresh module cache. Returns both the public
 * entry (index.js) and the client module (for the AtlasClient class) — same
 * instances, so getClient() inside index sees clients made via client.js.
 */
function loadFresh() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(DIST_DIR)) delete require.cache[key];
  }
  const sdk = require(path.join(DIST_DIR, "index.js"));
  const client = require(path.join(DIST_DIR, "client.js"));
  return { sdk, client };
}

/**
 * Install a fake global fetch. `plan` is an array of steps; the last one
 * repeats for any further calls:
 *   { status: 200 }           → resolve with that HTTP status
 *   { status: 200, text: "0"} → also expose a response body (destinations
 *                               with `inspectBody` read it)
 *   { hang: true }            → never settle until the AbortSignal fires, then
 *                               reject with an AbortError (a stalled connection)
 *   { url: /re/, ... }        → only matches requests whose URL matches; steps
 *                               are scanned in order and the first match wins,
 *                               so a plan can give different answers per vendor
 * Returns { calls } where calls[i] = { url, options, body } (body = parsed
 * JSON payload).
 */
function fakeFetch(plan) {
  const calls = [];
  // Per-URL-pattern call counters, so each vendor walks its own step list.
  // With no `url` on any step the key is constant and the plan is a plain
  // sequence, exactly as before.
  const counters = new Map();
  const pick = (url) => {
    const scoped = plan.filter((s) => !s.url || new RegExp(s.url).test(url));
    if (scoped.length === 0) return { status: 200 };
    const key = scoped.map((s) => plan.indexOf(s)).join(",");
    const seen = counters.get(key) || 0;
    counters.set(key, seen + 1);
    return scoped[Math.min(seen, scoped.length - 1)];
  };
  globalThis.fetch = (url, options) => {
    const step = pick(url);
    // `body` is the parsed JSON payload, or the raw string for the one
    // form-encoded endpoint (Amplitude's /identify).
    let body = null;
    if (options && options.body) {
      try {
        body = JSON.parse(options.body);
      } catch {
        body = options.body;
      }
    }
    calls.push({ url, options, body });
    if (step.hang) {
      return new Promise((_resolve, reject) => {
        const signal = options && options.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }
    return Promise.resolve({
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      text: () => Promise.resolve(step.text === undefined ? "" : step.text),
    });
  };
  return { calls };
}

/** Let the client's async identity load settle (memory storage = microtasks). */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

const TEST_CONFIG = {
  apiKey: "phc_test",
  atlasAppId: "atlas_test_app",
  host: "https://posthog.test",
  flushAt: 1000, // never auto-flush mid-test
  flushInterval: 3600000, // interval never fires during a test
};

module.exports = {
  TEST_CONFIG,
  emitAppState,
  fakeFetch,
  loadFresh,
  setExpoRouterStub,
  settle,
};
