/**
 * Mock Amplitude + Mixpanel, for exercising the non-PostHog paths end to end
 * without a paid account.
 *
 *   node demo/mock-vendors.cjs [port]     # default 8790
 *
 * It is a real (small) implementation of the vendor semantics, not a canned
 * response: it INGESTS events on the vendors' capture endpoints and then
 * ANSWERS their query endpoints by computing over what it stored. So the whole
 * loop is under test —
 *
 *   real SDK  →  vendor capture API  →  vendor query API  →  real report CLI
 *
 * — and if the SDK's payload mapping or the report's query/parse code is
 * wrong, the numbers come out wrong.
 *
 * Ingest
 *   POST /2/httpapi          Amplitude HTTP V2
 *   POST /identify           Amplitude Identify API (form-encoded)
 *   POST /track              Mixpanel
 *   POST /engage             Mixpanel profile updates
 * Query
 *   GET  /api/2/events/segmentation   Amplitude, m=uniques|totals, up to 2 group-bys
 *   GET  /api/2/funnels               Amplitude, mode=ordered, cs=<window seconds>
 *   GET  /api/2.0/export              Mixpanel raw export (JSONL)
 * Debug
 *   GET  /_stats                      what has been ingested so far
 */

const http = require("node:http");

const store = {
  amplitude: [], // { event_type, user_id, device_id, time, insert_id, event_properties }
  amplitudeIdentifications: [],
  mixpanel: [], // { event, properties }
  mixpanelProfiles: [],
};

/* ── helpers ────────────────────────────────────────────────── */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

/** Amplitude's user key: the identified id if present, else the device id. */
const ampUser = (e) => e.user_id || e.device_id;

/** Mixpanel's post-merge canonical id. */
const mpUser = (e) =>
  e.properties.$user_id || e.properties.distinct_id || e.properties.$device_id;

/** Does an event satisfy an Amplitude `e.filters` list? */
function matchesFilters(props, filters) {
  for (const f of filters || []) {
    const value = props[f.subprop_key];
    const wanted = f.subprop_value || [];
    const has = wanted.includes(String(value));
    if (f.subprop_op === "is" && !has) return false;
    if (f.subprop_op === "is not" && has) return false;
  }
  return true;
}

/** Amplitude reports an unset property as this label. */
const NONE = "(none)";
const labelOf = (v) => (v === undefined || v === null || v === "" ? NONE : String(v));

/* ── Amplitude: event segmentation ──────────────────────────── */

function segmentation(params) {
  const spec = JSON.parse(params.get("e"));
  const metric = params.get("m") || "uniques";
  const groupBy = (spec.group_by || []).map((g) => g.value);
  const limit = Number(params.get("limit") || 100);

  // group key → set of users (uniques) / count (totals)
  const uniques = new Map();
  const totals = new Map();
  for (const e of store.amplitude) {
    if (e.event_type !== spec.event_type) continue;
    const props = e.event_properties || {};
    if (!matchesFilters(props, spec.filters)) continue;
    const labels = groupBy.map((g) => labelOf(props[g]));
    const key = JSON.stringify(labels);
    if (!uniques.has(key)) uniques.set(key, new Set());
    uniques.get(key).add(ampUser(e));
    totals.set(key, (totals.get(key) || 0) + 1);
  }

  const rows = [...uniques.keys()]
    .map((key) => ({
      key,
      value: metric === "totals" ? totals.get(key) : uniques.get(key).size,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);

  return {
    data: {
      // One group-by → a bare string label; two → an array. (Matches the
      // shape the real API returns, which the report has to handle.)
      seriesLabels: rows.map((r) => {
        const labels = JSON.parse(r.key);
        return labels.length === 1 ? labels[0] : labels;
      }),
      seriesCollapsed: rows.map((r) => [{ value: r.value }]),
      series: rows.map((r) => [r.value]),
      xValues: [new Date().toISOString().slice(0, 10)],
    },
  };
}

/* ── Amplitude: ordered funnel ──────────────────────────────── */

function funnels(specs, windowSeconds) {
  // Per user, sorted timeline of (time, event_properties).
  const byUser = new Map();
  for (const e of store.amplitude) {
    const user = ampUser(e);
    if (!byUser.has(user)) byUser.set(user, []);
    byUser.get(user).push(e);
  }

  const cumulative = new Array(specs.length).fill(0);
  for (const events of byUser.values()) {
    events.sort((a, b) => a.time - b.time);
    let level = 0;
    let startedAt = null;
    for (const e of events) {
      const spec = specs[level];
      if (e.event_type !== spec.event_type) continue;
      if (!matchesFilters(e.event_properties || {}, spec.filters)) continue;
      if (level === 0) {
        startedAt = e.time;
      } else if ((e.time - startedAt) / 1000 > windowSeconds) {
        continue; // outside the conversion window
      }
      level++;
      if (level >= specs.length) break;
    }
    for (let k = 0; k < level; k++) cumulative[k]++;
  }
  return { data: [{ cumulativeRaw: cumulative, events: specs.map((s) => s.event_type) }] };
}

/* ── Mixpanel: raw export ───────────────────────────────────── */

/** Supports the one expression the report emits: properties["k"] == "v". */
function matchesWhere(props, where) {
  if (!where) return true;
  const m = /properties\["([^"]+)"\]\s*==\s*"([^"]*)"/.exec(where);
  if (!m) return true;
  return String(props[m[1]]) === m[2];
}

function exportJsonl(params, res) {
  const events = JSON.parse(params.get("event") || "null");
  const where = params.get("where");
  const timeInMs = params.get("time_in_ms") === "true" || params.get("time_in_ms") === "1";
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  for (const e of store.mixpanel) {
    if (events && !events.includes(e.event)) continue;
    if (!matchesWhere(e.properties, where)) continue;
    // The real export emits the merged distinct_id, and seconds unless
    // time_in_ms was asked for.
    const properties = { ...e.properties, distinct_id: mpUser(e) };
    if (!timeInMs && typeof properties.time === "number" && properties.time > 1e11) {
      properties.time = Math.floor(properties.time / 1000);
    }
    delete properties.token;
    res.write(JSON.stringify({ event: e.event, properties }) + "\n");
  }
  res.end();
}

/* ── server ─────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    /* ingest */
    if (req.method === "POST" && path === "/2/httpapi") {
      const body = JSON.parse(await readBody(req));
      if (!body.api_key) return json(res, 400, { error: "missing api_key" });
      store.amplitude.push(...(body.events || []));
      return json(res, 200, {
        code: 200,
        events_ingested: (body.events || []).length,
        server_upload_time: Date.now(),
      });
    }
    if (req.method === "POST" && path === "/identify") {
      const form = new URLSearchParams(await readBody(req));
      if (!form.get("api_key")) return json(res, 400, { error: "missing api_key" });
      store.amplitudeIdentifications.push(
        ...JSON.parse(form.get("identification") || "[]")
      );
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("success");
    }
    if (req.method === "POST" && path === "/track") {
      const batch = JSON.parse(await readBody(req));
      if (!Array.isArray(batch) || batch.some((e) => !e.properties?.token)) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("0"); // Mixpanel's "everything was rejected"
      }
      store.mixpanel.push(...batch);
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("1");
    }
    if (req.method === "POST" && path === "/engage") {
      store.mixpanelProfiles.push(...JSON.parse(await readBody(req)));
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("1");
    }

    /* query */
    if (req.method === "GET" && path === "/api/2/events/segmentation") {
      if (!req.headers.authorization) return json(res, 401, { error: "no auth" });
      return json(res, 200, segmentation(url.searchParams));
    }
    if (req.method === "GET" && path === "/api/2/funnels") {
      if (!req.headers.authorization) return json(res, 401, { error: "no auth" });
      const specs = url.searchParams.getAll("e").map((e) => JSON.parse(e));
      const cs = Number(url.searchParams.get("cs") || 2592000);
      return json(res, 200, funnels(specs, cs));
    }
    if (req.method === "GET" && path === "/api/2.0/export") {
      if (!req.headers.authorization) return json(res, 401, { error: "no auth" });
      if (!url.searchParams.get("project_id")) {
        return json(res, 400, { error: "project_id required for service accounts" });
      }
      return exportJsonl(url.searchParams, res);
    }

    if (req.method === "GET" && path === "/_stats") {
      return json(res, 200, {
        amplitude_events: store.amplitude.length,
        amplitude_identifications: store.amplitudeIdentifications.length,
        mixpanel_events: store.mixpanel.length,
        mixpanel_profiles: store.mixpanelProfiles.length,
      });
    }

    json(res, 404, { error: `no route for ${req.method} ${path}` });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});

const port = Number(process.argv[2] || 8790);
server.listen(port, () => {
  console.log(`mock Amplitude + Mixpanel listening on http://localhost:${port}`);
});
