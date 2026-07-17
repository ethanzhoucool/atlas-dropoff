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
