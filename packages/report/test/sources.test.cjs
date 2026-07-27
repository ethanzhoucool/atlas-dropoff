'use strict';
/* Analytics sources: request shapes, response parsing, and selection.
   Every vendor is stubbed at the fetch boundary — these pin the query we
   send and the numbers we read back out of the answer. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sourcesP = import('../dist/sources/index.js');
const mixpanelP = import('../dist/sources/mixpanel.js');

/** Capture outgoing requests and answer each with the next planned payload. */
function stubFetch(plan) {
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    const step = plan[Math.min(calls.length - 1, plan.length - 1)];
    if (step.throws) return Promise.reject(new Error(step.throws));
    const body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {});
    const status = step.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: step.statusText ?? '',
      json: () => Promise.resolve(JSON.parse(body)),
      text: () => Promise.resolve(body),
      body: step.stream ? toStream(body) : null,
    });
  };
  return calls;
}

/** Minimal web ReadableStream over a string, chunked to exercise line splitting. */
function toStream(text) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return {
    getReader() {
      return {
        read() {
          if (offset >= bytes.length) return Promise.resolve({ done: true });
          // 7-byte chunks: lines are split across reads on purpose.
          const end = Math.min(offset + 7, bytes.length);
          const value = bytes.slice(offset, end);
          offset = end;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

/** Parse the `e`/`m`/… query params of a Dashboard REST URL. */
function queryParams(url) {
  const qs = url.slice(url.indexOf('?') + 1);
  const out = { e: [] };
  for (const pair of qs.split('&')) {
    const i = pair.indexOf('=');
    const key = decodeURIComponent(pair.slice(0, i));
    const value = decodeURIComponent(pair.slice(i + 1));
    if (key === 'e') out.e.push(JSON.parse(value));
    else out[key] = value;
  }
  return out;
}

const AMPLITUDE_OPTS = {
  apiKey: 'amp_key',
  secretKey: 'amp_secret',
  appId: 'app-uuid',
  days: 7,
};

/** A segmentation answer: labels + range-collapsed values. */
function segmentation(rows) {
  return {
    data: {
      seriesLabels: rows.map(r => r.labels),
      seriesCollapsed: rows.map(r => [{ value: r.value }]),
    },
  };
}

/* ── Amplitude ──────────────────────────────────────────────── */

test('amplitude: segmentation query carries the app filter and group-bys', async () => {
  const { amplitudeSource } = await sourcesP;
  const calls = stubFetch([{ body: segmentation([{ labels: '/home', value: 10 }]) }]);
  await amplitudeSource(AMPLITUDE_OPTS).fetchCounts();

  // screens (uniques), screens (totals), transitions, leavers
  assert.equal(calls.length, 4);
  const screens = queryParams(calls[0].url);
  assert.ok(calls[0].url.startsWith('https://amplitude.com/api/2/events/segmentation?'));
  assert.equal(screens.m, 'uniques');
  assert.equal(screens.e[0].event_type, 'atlas_screen');
  assert.deepEqual(screens.e[0].filters, [
    {
      subprop_type: 'event',
      subprop_key: 'atlas_app_id',
      subprop_op: 'is',
      subprop_value: ['app-uuid'],
    },
  ]);
  assert.deepEqual(screens.e[0].group_by, [{ type: 'event', value: 'screen' }]);
  // Basic auth over api-key:secret-key.
  const auth = Buffer.from('amp_key:amp_secret').toString('base64');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${auth}`);

  // Raw view counts come from a second query with m=totals.
  assert.equal(queryParams(calls[1].url).m, 'totals');
  // Transitions group by BOTH ends of the hop.
  assert.deepEqual(queryParams(calls[2].url).e[0].group_by, [
    { type: 'event', value: 'prev_screen' },
    { type: 'event', value: 'screen' },
  ]);
  assert.deepEqual(queryParams(calls[3].url).e[0].group_by, [
    { type: 'event', value: 'prev_screen' },
  ]);
});

test('amplitude: reads range-collapsed uniques and drops (none) groups', async () => {
  const { amplitudeSource } = await sourcesP;
  stubFetch([
    { body: segmentation([{ labels: '/home', value: 120 }, { labels: '/cart', value: 40 }]) },
    { body: segmentation([{ labels: '/home', value: 300 }, { labels: '/cart', value: 55 }]) },
    {
      body: segmentation([
        { labels: ['/home', '/cart'], value: 38 },
        // First screen of a session: prev_screen is unset, not a real hop.
        { labels: ['(none)', '/home'], value: 120 },
      ]),
    },
    { body: segmentation([{ labels: '/home', value: 44 }]) },
  ]);

  const counts = await amplitudeSource(AMPLITUDE_OPTS).fetchCounts();
  assert.equal(counts.source, 'amplitude');
  assert.deepEqual(counts.screens['/home'], { users: 120, events: 300 });
  assert.deepEqual(counts.transitions, [{ src: '/home', dst: '/cart', users: 38 }]);
  assert.deepEqual(counts.leavers, { '/home': 44 });
});

test('amplitude: an empty result is an error, not a blank report', async () => {
  const { amplitudeSource } = await sourcesP;
  stubFetch([{ body: segmentation([]) }]);
  await assert.rejects(
    () => amplitudeSource(AMPLITUDE_OPTS).fetchCounts(),
    /returned 0 atlas_screen events/,
  );
});

test('amplitude: a 403 explains which credential is wrong', async () => {
  const { amplitudeSource } = await sourcesP;
  stubFetch([{ status: 403, statusText: 'Forbidden', body: 'nope' }]);
  await assert.rejects(
    () => amplitudeSource(AMPLITUDE_OPTS).fetchCounts(),
    /AMPLITUDE_API_KEY \/ AMPLITUDE_SECRET_KEY/,
  );
});

test('amplitude: funnel steps filter on the screen keys of each node', async () => {
  const { amplitudeSource } = await sourcesP;
  const calls = stubFetch([{ body: { data: [{ cumulativeRaw: [100, 60, 25] }] } }]);
  const cohort = await amplitudeSource(AMPLITUDE_OPTS).fetchFunnel(
    [['/home'], ['/cart', '/cart-v2'], ['/done']],
    3600,
  );
  assert.deepEqual(cohort, [100, 60, 25]);

  const params = queryParams(calls[0].url);
  assert.ok(calls[0].url.includes('/api/2/funnels?'));
  assert.equal(params.mode, 'ordered');
  assert.equal(params.cs, '3600');
  assert.equal(params.e.length, 3);
  // Step 2 accepts either alias of the same Atlas node.
  assert.deepEqual(params.e[1].filters[1], {
    subprop_type: 'event',
    subprop_key: 'screen',
    subprop_op: 'is',
    subprop_value: ['/cart', '/cart-v2'],
  });
});

test('amplitude: funnel cohort is clamped monotone even if the API is not', async () => {
  const { amplitudeSource } = await sourcesP;
  stubFetch([{ body: { data: [{ cumulativeRaw: [100, 60, 80] }] } }]);
  const cohort = await amplitudeSource(AMPLITUDE_OPTS).fetchFunnel(
    [['/a'], ['/b'], ['/c']],
    3600,
  );
  assert.deepEqual(cohort, [100, 60, 60]);
});

test('amplitude: a funnel over the cost ceiling fails fast with a fix', async () => {
  const { amplitudeSource } = await sourcesP;
  const calls = stubFetch([{ body: {} }]);
  const steps = Array.from({ length: 20 }, (_, i) => [`/s${i}`]);
  // 28 days × 20 steps × 2 = 1120, past Amplitude's ~1000 concurrent cost cap.
  await assert.rejects(
    () => amplitudeSource({ ...AMPLITUDE_OPTS, days: 28 }).fetchFunnel(steps, 3600),
    /Lower --days to \d+/,
  );
  assert.equal(calls.length, 0, 'must not fire a request it knows will be refused');
});

/* ── Mixpanel ───────────────────────────────────────────────── */

test('mixpanel: exports the app`s events and counts distinct users locally', async () => {
  const { mixpanelSource } = await sourcesP;
  const lines = [
    { event: 'atlas_screen', properties: { screen: '/home', prev_screen: null, distinct_id: 'u1', atlas_app_id: 'app-uuid', time: 100 } },
    { event: 'atlas_screen', properties: { screen: '/cart', prev_screen: '/home', distinct_id: 'u1', atlas_app_id: 'app-uuid', time: 200 } },
    { event: 'atlas_screen', properties: { screen: '/home', prev_screen: null, distinct_id: 'u2', atlas_app_id: 'app-uuid', time: 100 } },
  ]
    .map(e => JSON.stringify(e))
    .join('\n');
  const calls = stubFetch([{ body: lines, stream: true }]);

  const source = mixpanelSource({
    username: 'sa', secret: 'sk', projectId: '42', appId: 'app-uuid', days: 7,
  });
  const counts = await source.fetchCounts();

  assert.ok(calls[0].url.startsWith('https://data.mixpanel.com/api/2.0/export?'));
  assert.ok(calls[0].url.includes('project_id=42'));
  assert.ok(decodeURIComponent(calls[0].url).includes('properties["atlas_app_id"] == "app-uuid"'));
  assert.equal(counts.source, 'mixpanel');
  assert.equal(counts.screens['/home'].users, 2);
  assert.equal(counts.screens['/cart'].users, 1);

  // The export is fetched once; the funnel reuses the same stream.
  assert.deepEqual(await source.fetchFunnel([['/home'], ['/cart']], 86400), [2, 1]);
  assert.equal(calls.length, 1);
});

test('mixpanel: jsonlLines reassembles lines split across chunks', async () => {
  const { jsonlLines } = await mixpanelP;
  const text = 'alpha\nbravo\ncharlie-is-a-long-one\n';
  const res = { body: toStream(text), text: () => Promise.resolve(text) };
  const out = [];
  for await (const line of jsonlLines(res)) out.push(line);
  assert.deepEqual(out, ['alpha', 'bravo', 'charlie-is-a-long-one']);
});

test('mixpanel: a 401 names the service-account credentials', async () => {
  const { mixpanelSource } = await sourcesP;
  stubFetch([{ status: 401, statusText: 'Unauthorized', body: 'bad auth' }]);
  await assert.rejects(
    () => mixpanelSource({
      username: 'sa', secret: 'sk', projectId: '42', appId: 'app-uuid', days: 7,
    }).fetchCounts(),
    /MIXPANEL_SERVICE_ACCOUNT/,
  );
});

/* ── events file ────────────────────────────────────────────── */

test('events file: reads JSONL and answers both questions', async () => {
  const { eventsFileSource } = await sourcesP;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-')), 'events.jsonl');
  fs.writeFileSync(
    file,
    [
      '',
      '{ broken json',
      JSON.stringify({ event: 'atlas_screen', properties: { screen: '/a', prev_screen: null, distinct_id: 'u1', time: 10 } }),
      JSON.stringify({ event: 'atlas_screen', properties: { screen: '/b', prev_screen: '/a', distinct_id: 'u1', time: 20 } }),
      JSON.stringify({ event: 'atlas_screen', properties: { screen: '/a', prev_screen: null, distinct_id: 'u2', time: 10 } }),
    ].join('\n'),
  );

  const source = eventsFileSource({ file });
  const counts = await source.fetchCounts();
  assert.equal(counts.source, 'events-file');
  assert.equal(counts.screens['/a'].users, 2);
  assert.deepEqual(await source.fetchFunnel([['/a'], ['/b']], 86400), [2, 1]);
});

test('events file: a file with nothing usable says so', async () => {
  const { eventsFileSource } = await sourcesP;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-')), 'empty.jsonl');
  fs.writeFileSync(file, 'garbage\nmore garbage\n');
  await assert.rejects(
    () => eventsFileSource({ file }).fetchCounts(),
    /No usable events/,
  );
});

/* ── source selection ───────────────────────────────────────── */

test('chooseSourceName: explicit flag wins over everything', async () => {
  const { chooseSourceName } = await sourcesP;
  const sel = {
    source: 'mixpanel', counts: 'c.json', days: 7, appId: 'a',
    env: { POSTHOG_PERSONAL_API_KEY: 'phx' },
  };
  assert.deepEqual(chooseSourceName(sel), { name: 'mixpanel', why: 'explicit' });
});

test('chooseSourceName: offline flags, then the one vendor with credentials', async () => {
  const { chooseSourceName } = await sourcesP;
  const base = { days: 7, appId: 'a', env: {} };
  assert.equal(chooseSourceName({ ...base, counts: 'c.json' }).name, 'counts');
  assert.equal(chooseSourceName({ ...base, events: 'e.jsonl' }).name, 'events');

  assert.deepEqual(
    chooseSourceName({ ...base, env: { AMPLITUDE_API_KEY: 'k', AMPLITUDE_SECRET_KEY: 's' } }),
    { name: 'amplitude', why: 'env' },
  );
  // Ambiguous (two vendors) or empty → PostHog default, which then reports its
  // own missing-credential error.
  assert.deepEqual(
    chooseSourceName({
      ...base,
      env: {
        AMPLITUDE_API_KEY: 'k', AMPLITUDE_SECRET_KEY: 's', POSTHOG_PERSONAL_API_KEY: 'phx',
      },
    }),
    { name: 'posthog', why: 'default' },
  );
  assert.deepEqual(chooseSourceName(base), { name: 'posthog', why: 'default' });
});

test('chooseSourceName: an unknown --source lists the valid ones', async () => {
  const { chooseSourceName } = await sourcesP;
  assert.throws(
    () => chooseSourceName({ source: 'segment', days: 7, appId: 'a', env: {} }),
    /Unknown --source "segment"/,
  );
});

test('createSource: each vendor names the exact credential it is missing', async () => {
  const { createSource } = await sourcesP;
  const base = { days: 7, appId: 'a', env: {} };
  assert.throws(
    () => createSource({ ...base, source: 'amplitude' }),
    /AMPLITUDE_API_KEY is not set/,
  );
  assert.throws(
    () => createSource({
      ...base, source: 'amplitude', env: { AMPLITUDE_API_KEY: 'k' },
    }),
    /AMPLITUDE_SECRET_KEY is not set/,
  );
  assert.throws(
    () => createSource({ ...base, source: 'mixpanel' }),
    /MIXPANEL_SERVICE_ACCOUNT is not set/,
  );
  assert.throws(
    () => createSource({
      ...base,
      source: 'mixpanel',
      env: { MIXPANEL_SERVICE_ACCOUNT: 'sa', MIXPANEL_SERVICE_SECRET: 'sk' },
    }),
    /No Mixpanel project id/,
  );
  assert.throws(
    () => createSource({ ...base, source: 'posthog' }),
    /POSTHOG_PERSONAL_API_KEY is not set/,
  );
});

test('createSource: region and host route to the right endpoint', async () => {
  const { createSource } = await sourcesP;
  const calls = stubFetch([{ body: { data: { seriesLabels: [], seriesCollapsed: [] } } }]);
  const source = createSource({
    source: 'amplitude',
    region: 'eu',
    days: 7,
    appId: 'a',
    env: { AMPLITUDE_API_KEY: 'k', AMPLITUDE_SECRET_KEY: 's' },
  });
  assert.equal(source.id, 'amplitude');
  await source.fetchCounts().catch(() => {});
  assert.ok(calls[0].url.startsWith('https://analytics.eu.amplitude.com/'));
});
