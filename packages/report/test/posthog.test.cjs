'use strict';
/* Tests for the PostHog module (built dist/ — run `npm test`): explicit
   LIMITs on every HogQL query, and the --counts file loader contract. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const posthogP = import('../dist/posthog.js');

function writeTmpJson(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-report-test-'));
  const file = path.join(dir, 'counts.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

/* ── HogQL LIMITs (silent ~100-row truncation guard) ────────── */

test('all three HogQL queries carry an explicit LIMIT', async () => {
  const { screensQuery, transitionsQuery, leaversQuery, QUERY_ROW_LIMIT } = await posthogP;
  assert.equal(QUERY_ROW_LIMIT, 50000);
  for (const sql of [screensQuery(28), transitionsQuery(28), leaversQuery(28)]) {
    assert.match(sql, /LIMIT 50000\s*$/, `query must end with LIMIT 50000:\n${sql}`);
  }
});

/* ── sequential funnel (windowFunnel) ───────────────────────── */

test('funnelQuery builds a windowFunnel over N ordered steps, keys bound via values', async () => {
  const { funnelQuery, FUNNEL_MAX_STEPS } = await posthogP;
  assert.equal(FUNNEL_MAX_STEPS, 32);
  const sql = funnelQuery(28, 86400, 3);
  assert.match(sql, /windowFunnel\(86400\)/);
  for (const k of [1, 2, 3]) assert.match(sql, new RegExp(`countIf\\(level >= ${k}\\) AS s${k}`));
  // Step keys are bound as {stepK} values, never spliced into SQL text.
  for (const k of [0, 1, 2]) assert.match(sql, new RegExp(`properties\\.screen IN \\{step${k}\\}`));
  assert.match(sql, /properties\.atlas_app_id = \{app_id\}/);
  assert.throws(() => funnelQuery(28, 86400, 1), /2\.\.32 steps/);
  assert.throws(() => funnelQuery(28, 86400, 33), /2\.\.32 steps/);
  assert.throws(() => funnelQuery(28, 0, 3), /window/);
});

test('fetchFunnel parses the funnel row and enforces a monotone cohort', async () => {
  const { fetchFunnel } = await posthogP;
  const orig = global.fetch;
  let sentBody;
  // Row is non-monotone on purpose (120 > 100): must be clamped down.
  global.fetch = async (_url, init) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ results: [[100, 120, 40]] }) };
  };
  try {
    const cohort = await fetchFunnel(
      { host: 'http://x', projectId: '1', apiKey: 'k', appId: 'app-42', days: 28 },
      [['/a'], ['/b1', '/b2'], ['/c']],
      86400,
    );
    assert.deepEqual(cohort, [100, 100, 40]);
    // step key arrays are passed as values, not spliced into SQL
    assert.deepEqual(sentBody.query.values.step1, ['/b1', '/b2']);
    assert.equal(sentBody.query.values.app_id, 'app-42');
  } finally {
    global.fetch = orig;
  }
});

/* ── loadCountsFile: accepts the documented schema ──────────── */

test('loadCountsFile accepts the shipped counts.example.json (full schema incl. leavers)', async () => {
  const { loadCountsFile } = await posthogP;
  const counts = loadCountsFile(path.join(__dirname, '..', 'counts.example.json'));
  assert.equal(counts.source, 'counts-file');
  assert.equal(counts.date_range, 'Last 28 days');
  assert.equal(Object.keys(counts.screens).length, 8);
  assert.deepEqual(counts.screens['onboarding/welcome'], { users: 8420, events: 9105 });
  assert.equal(counts.transitions.length, 9);
  assert.equal(counts.leavers['onboarding/welcome'], 7240);
});

test('loadCountsFile accepts a minimal file (no transitions/leavers, events defaults to users)', async () => {
  const { loadCountsFile } = await posthogP;
  const file = writeTmpJson({ screens: { home: { users: 42 } } });
  const counts = loadCountsFile(file);
  assert.deepEqual(counts.screens.home, { users: 42, events: 42 });
  assert.deepEqual(counts.transitions, []);
  assert.equal(counts.leavers, undefined);
});

test('loadCountsFile accepts optional leavers (including empty {})', async () => {
  const { loadCountsFile } = await posthogP;
  const withLeavers = loadCountsFile(
    writeTmpJson({
      screens: { a: { users: 10, events: 12 } },
      transitions: [{ src: 'a', dst: 'b', users: 5 }],
      leavers: { a: 7 },
    }),
  );
  assert.deepEqual(withLeavers.leavers, { a: 7 });
  assert.deepEqual(withLeavers.transitions, [{ src: 'a', dst: 'b', users: 5 }]);

  const emptyLeavers = loadCountsFile(
    writeTmpJson({ screens: { a: { users: 10 } }, leavers: {} }),
  );
  assert.deepEqual(emptyLeavers.leavers, {});
});

/* ── loadCountsFile: rejects malformed input ────────────────── */

test('loadCountsFile rejects malformed input', async () => {
  const { loadCountsFile } = await posthogP;
  const bad = [
    ['not JSON at all', 'not-json{'],
    ['array root', [1, 2, 3]],
    ['missing screens', { transitions: [] }],
    ['screens as array', { screens: [] }],
    ['screen entry not an object', { screens: { home: 42 } }],
    ['transitions not an array', { screens: { home: { users: 1 } }, transitions: {} }],
    ['transition missing src/dst', { screens: { home: { users: 1 } }, transitions: [{ users: 3 }] }],
    ['leavers as array', { screens: { home: { users: 1 } }, leavers: [] }],
  ];
  for (const [label, value] of bad) {
    assert.throws(() => loadCountsFile(writeTmpJson(value)), new RegExp('.'), `must reject: ${label}`);
  }
});
