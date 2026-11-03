'use strict';
/* Tests for the funnel math (built dist/ modules — run `npm test`, which
   builds first). Focus: the min-cohort conversion fix, max-not-sum for
   many-to-one screen mappings, and the empty-leavers guard. */
const test = require('node:test');
const assert = require('node:assert/strict');

const funnelP = import('../dist/funnel.js');
const mapP = import('../dist/map.js');

/* ── tiny Atlas fixtures ────────────────────────────────────── */

function makeNode(id, extra = {}) {
  return {
    id,
    name: id,
    product_area: 'Test',
    screen_kind: null,
    description: null,
    observation_count: 1,
    is_entry_point: false,
    is_terminal: false,
    is_hub: false,
    primary_actions: [],
    visible_labels: [],
    rep_observation_id: null,
    screenshot: null,
    rank: 0,
    lane: 'Test',
    parent_id: null,
    role: null,
    ...extra,
  };
}

function makeEdge(source, target, extra = {}) {
  return {
    source,
    target,
    label: null,
    action_type: null,
    observation_count: 1,
    session_support: 1,
    is_primary: true,
    ...extra,
  };
}

function makeAtlas(nodes, edges) {
  return { app_id: 'test-app', app_name: 'Test', stats: {}, nodes, edges };
}

/** mapScreens + buildNodeTransitions + computeAnalytics with warn collectors. */
async function computeAll(atlas, counts, explicit = {}) {
  const { mapScreens } = await mapP;
  const { buildNodeTransitions, computeAnalytics } = await funnelP;
  const warnings = [];
  const warn = line => warnings.push(line);
  const mapping = mapScreens(counts, atlas, explicit, warn);
  const transitions = buildNodeTransitions(counts, mapping);
  const analytics = computeAnalytics(atlas, counts, mapping, transitions, {
    dateRange: 'test window',
    disclaimer: 'test',
    warn,
  });
  return { analytics, transitions, warnings };
}

/* ── finding-1 regression: views are not traversals ─────────── */

test('conversion uses the min-cohort, not goal-screen viewers (A=100, A→B=50, B=120)', async () => {
  const atlas = makeAtlas(
    [makeNode('A', { is_entry_point: true }), makeNode('B')],
    [makeEdge('A', 'B')],
  );
  const counts = {
    source: 'counts-file',
    screens: {
      A: { users: 100, events: 100 },
      B: { users: 120, events: 130 }, // more viewers than the entry — arrive by other paths
    },
    transitions: [{ src: 'A', dst: 'B', users: 50 }],
  };
  const { analytics } = await computeAll(atlas, counts);
  const t = analytics.totals;

  assert.equal(t.sessions, 100);
  assert.equal(t.converted, 50, 'converted must be the transition bottleneck, not B viewers');
  assert.equal(t.conversion_pct, 50);
  assert.ok(t.conversion_pct <= 100);

  // No step or total may exceed 100% of anything upstream.
  assert.equal(analytics.funnel.length, 2);
  for (const [i, step] of analytics.funnel.entries()) {
    assert.ok(step.users <= t.sessions, `step ${step.step} users <= sessions`);
    assert.ok(step.conversion_from_prev <= 1, `step ${step.step} conversion <= 100%`);
    assert.ok(step.drop_pct >= 0 && step.drop_pct <= 1);
    if (i > 0) assert.ok(step.users <= analytics.funnel[i - 1].users);
  }
  assert.equal(analytics.funnel[1].users, 50);
  assert.equal(analytics.funnel[1].conversion_from_prev, 0.5);
  assert.equal(analytics.funnel[1].drop_pct, 0.5);
  assert.equal(analytics.funnel[1].lost, 50);

  // The per-screen viewer totals stay untouched — the flow map legitimately
  // shows total screen traffic.
  assert.equal(analytics.screens.B.users, 120);

  // Goal insight uses the cohort, so it can never claim >100%.
  assert.match(analytics.screens.B.insight, /50 of 100 users/);
  assert.match(analytics.screens.B.insight, /\(50%\)/);
});

/* ── min-cohort monotonicity ────────────────────────────────── */

test('min-cohort is monotone non-increasing on a 3-step path (transition caps)', async () => {
  const atlas = makeAtlas(
    [makeNode('A', { is_entry_point: true }), makeNode('B'), makeNode('C')],
    [makeEdge('A', 'B'), makeEdge('B', 'C')],
  );
  const counts = {
    source: 'counts-file',
    screens: {
      A: { users: 1000, events: 1000 },
      B: { users: 800, events: 800 },
      C: { users: 700, events: 700 },
    },
    transitions: [
      { src: 'A', dst: 'B', users: 600 },
      { src: 'B', dst: 'C', users: 650 }, // exceeds the surviving cohort — must be capped
    ],
  };
  const { analytics } = await computeAll(atlas, counts);
  const f = analytics.funnel;
  assert.equal(f.length, 3);
  assert.deepEqual(f.map(s => s.users), [1000, 600, 600]);
  for (let i = 1; i < f.length; i++) {
    assert.ok(f[i].users <= f[i - 1].users, `cohort[${i}] <= cohort[${i - 1}]`);
    assert.ok(f[i].conversion_from_prev <= 1);
  }
  assert.equal(analytics.totals.converted, 600);
});

test('min-cohort falls back to viewer counts when no transition data exists', async () => {
  const atlas = makeAtlas(
    [makeNode('A', { is_entry_point: true }), makeNode('B'), makeNode('C')],
    [makeEdge('A', 'B'), makeEdge('B', 'C')],
  );
  const counts = {
    source: 'counts-file',
    screens: {
      A: { users: 1000, events: 1000 },
      B: { users: 800, events: 800 },
      C: { users: 900, events: 900 }, // more viewers than B — cohort must not grow
    },
    transitions: [],
  };
  const { analytics } = await computeAll(atlas, counts);
  assert.deepEqual(analytics.funnel.map(s => s.users), [1000, 800, 800]);
  assert.equal(analytics.totals.converted, 800);
  assert.ok(analytics.totals.conversion_pct <= 100);
});

/* ── many-to-one mappings: max, not sum ─────────────────────── */

test('multiple keys mapping to one node use max (users, transitions, leavers) and warn', async () => {
  const atlas = makeAtlas(
    [makeNode('A', { is_entry_point: true }), makeNode('B')],
    [makeEdge('A', 'B')],
  );
  const counts = {
    source: 'counts-file',
    screens: {
      a1: { users: 100, events: 100 },
      a2: { users: 80, events: 80 },
      B: { users: 90, events: 90 },
    },
    transitions: [
      { src: 'a1', dst: 'B', users: 60 },
      { src: 'a2', dst: 'B', users: 50 },
    ],
    leavers: { a1: 70, a2: 60, B: 10 },
  };
  const { analytics, transitions, warnings } = await computeAll(atlas, counts, {
    a1: 'A',
    a2: 'A',
  });

  // max(100, 80) = 100, never 180
  assert.equal(analytics.screens.A.users, 100);
  // node transitions collapse with max too: max(60, 50) = 60, never 110
  assert.equal(transitions.get('A').get('B'), 60);
  // leavers with max: exit = 1 - 70/100
  assert.equal(analytics.screens.A.exit_rate, 0.3);
  // funnel driven by the collapsed transition
  assert.equal(analytics.totals.converted, 60);

  const joined = warnings.join('\n');
  assert.match(joined, /multiple screen keys/i, 'must warn about many-to-one mappings');
  assert.match(joined, /a1, a2/);
});

/* ── empty leavers guard ────────────────────────────────────── */

test('empty leavers:{} falls back to transition sums instead of forcing 100% exit', async () => {
  const atlas = makeAtlas(
    [makeNode('A', { is_entry_point: true }), makeNode('B')],
    [makeEdge('A', 'B')],
  );
  const counts = {
    source: 'counts-file',
    screens: {
      A: { users: 100, events: 100 },
      B: { users: 60, events: 60 },
    },
    transitions: [{ src: 'A', dst: 'B', users: 50 }],
    leavers: {}, // present but empty — must not mean "everyone exited everywhere"
  };
  const { analytics } = await computeAll(atlas, counts);
  assert.equal(analytics.screens.A.exit_rate, 0.5, 'exit rate from out-transitions, not 100%');
  assert.notEqual(analytics.screens.A.exit_rate, 1);
});

/* ── sequential cohort override (live windowFunnel) ─────────── */

test('sequentialCohort override replaces the min-cohort estimate', async () => {
  const { mapScreens } = await mapP;
  const { buildNodeTransitions, computeAnalytics, buildFunnelPath, nodeUsersFromCounts } = await funnelP;
  const atlas = makeAtlas(
    [makeNode('A', { is_entry_point: true }), makeNode('B'), makeNode('C')],
    [makeEdge('A', 'B'), makeEdge('B', 'C')],
  );
  const counts = {
    source: 'posthog',
    screens: {
      A: { users: 1000, events: 1000 },
      B: { users: 800, events: 800 },
      C: { users: 700, events: 700 },
    },
    transitions: [
      { src: 'A', dst: 'B', users: 600 },
      { src: 'B', dst: 'C', users: 650 },
    ],
  };
  const mapping = mapScreens(counts, atlas, {});
  const transitions = buildNodeTransitions(counts, mapping);
  const { users } = nodeUsersFromCounts(counts, mapping);
  const byId = new Map(atlas.nodes.map(n => [n.id, n]));
  const path = buildFunnelPath(atlas, byId, users, transitions);
  assert.deepEqual(path, ['A', 'B', 'C']);

  // The exact sequential funnel (from windowFunnel) must override the
  // min-cohort estimate, which alone would give [1000, 600, 600].
  const analytics = computeAnalytics(atlas, counts, mapping, transitions, {
    dateRange: 'w',
    disclaimer: 'sequential',
    path,
    sequentialCohort: [900, 400, 300],
  });
  assert.deepEqual(analytics.funnel.map(s => s.users), [900, 400, 300]);
  assert.equal(analytics.totals.sessions, 900);
  assert.equal(analytics.totals.converted, 300);
  // per-screen viewer totals are still the raw counts, not the cohort
  assert.equal(analytics.screens.B.users, 800);
});

/* ── duplicate-name collision warning (map.ts) ──────────────── */

test('mapScreens warns when two Atlas nodes normalize to the same name key', async () => {
  const { mapScreens } = await mapP;
  const atlas = makeAtlas(
    [
      makeNode('id-1', { name: 'Check Out' }),
      makeNode('id-2', { name: 'check_out' }), // normalizes identically
    ],
    [],
  );
  const counts = {
    source: 'counts-file',
    screens: { 'check out': { users: 10, events: 10 } },
    transitions: [],
  };
  const warnings = [];
  const mapping = mapScreens(counts, atlas, {}, line => warnings.push(line));
  assert.equal(mapping.screenToNode.get('check out'), 'id-1');
  const joined = warnings.join('\n');
  assert.match(joined, /share the name key/);
  assert.match(joined, /id-1/);
  assert.match(joined, /id-2/);
});

/* ── empty cohorts and zero-traffic screens ─────────────────── */

test('mapped screens that all carry 0 users fail with a clear error, not a reduce() crash', async () => {
  const atlas = makeAtlas([makeNode('A', { is_entry_point: true }), makeNode('B')], [makeEdge('A', 'B')]);
  const counts = {
    source: 'counts-file',
    screens: { A: { users: 0, events: 3 }, B: { users: 0, events: 0 } },
    transitions: [],
  };
  await assert.rejects(() => computeAll(atlas, counts), /every one has 0 distinct users/);

  const { buildFunnelPath } = await funnelP;
  const byId = new Map(atlas.nodes.map(n => [n.id, n]));
  assert.deepEqual(buildFunnelPath(atlas, byId, new Map([['A', 0]]), new Map()), []);
});

test('screens_with_data counts only nodes that saw traffic', async () => {
  const atlas = makeAtlas(
    [makeNode('A', { is_entry_point: true }), makeNode('B'), makeNode('C')],
    [makeEdge('A', 'B')],
  );
  const counts = {
    source: 'counts-file',
    screens: {
      A: { users: 100, events: 100 },
      B: { users: 40, events: 40 },
      C: { users: 0, events: 0 }, // mapped, but no traffic in the window
    },
    transitions: [{ src: 'A', dst: 'B', users: 40 }],
  };
  const { analytics } = await computeAll(atlas, counts);
  assert.equal(analytics.totals.screens_with_data, 2);
  assert.equal(analytics.screens.C, undefined);
});

test('a step after an empty step reports no drop, not −100% of nobody', async () => {
  const { mapScreens } = await mapP;
  const { buildNodeTransitions, computeAnalytics } = await funnelP;
  const atlas = makeAtlas(
    [makeNode('A', { is_entry_point: true }), makeNode('B'), makeNode('C'), makeNode('D')],
    [makeEdge('A', 'B'), makeEdge('B', 'C'), makeEdge('C', 'D')],
  );
  const counts = {
    source: 'events-file',
    screens: {
      A: { users: 100, events: 100 },
      B: { users: 30, events: 30 },
      C: { users: 20, events: 20 },
      D: { users: 10, events: 10 },
    },
    transitions: [
      { src: 'A', dst: 'B', users: 30 },
      { src: 'B', dst: 'C', users: 20 },
      { src: 'C', dst: 'D', users: 10 },
    ],
  };
  const mapping = mapScreens(counts, atlas, {}, () => {});
  const transitions = buildNodeTransitions(counts, mapping);
  // An exact funnel where nobody completed A→B in order (say, a short
  // --funnel-window): steps 3 and 4 have an empty previous step.
  const analytics = computeAnalytics(atlas, counts, mapping, transitions, {
    dateRange: 'w',
    disclaimer: 'd',
    warn: () => {},
    path: ['A', 'B', 'C', 'D'],
    sequentialCohort: [100, 0, 0, 0],
  });
  const [, b, c, d] = analytics.funnel;
  assert.equal(b.drop_pct, 1);
  assert.equal(b.lost, 100);
  for (const s of [c, d]) {
    assert.equal(s.drop_pct, 0, `${s.screen_id}: no one could drop from an empty step`);
    assert.equal(s.lost, 0);
    assert.equal(s.conversion_from_prev, 0);
    assert.match(s.note, /No users reached/);
    assert.doesNotMatch(s.note, /−100%/);
  }
  // The real leak (A→B) is the biggest, with real users lost.
  assert.equal(analytics.totals.biggest_leak.screen_id, 'A');
  assert.equal(analytics.totals.biggest_leak.lost, 100);
});

test('an empty entry cohort cannot become a "biggest leak" of 0 users', async () => {
  const { mapScreens } = await mapP;
  const { buildNodeTransitions, computeAnalytics } = await funnelP;
  const atlas = makeAtlas([makeNode('A', { is_entry_point: true }), makeNode('B')], [makeEdge('A', 'B')]);
  const counts = {
    source: 'counts-file',
    screens: { A: { users: 10, events: 10 }, B: { users: 5, events: 5 } },
    transitions: [{ src: 'A', dst: 'B', users: 5 }],
  };
  const mapping = mapScreens(counts, atlas, {}, () => {});
  const analytics = computeAnalytics(atlas, counts, mapping, buildNodeTransitions(counts, mapping), {
    dateRange: 'w',
    disclaimer: 'd',
    warn: () => {},
    path: ['A', 'B'],
    sequentialCohort: [0, 0],
  });
  assert.equal(analytics.funnel[1].drop_pct, 0);
  assert.equal(analytics.totals.biggest_leak, null);
  assert.equal(analytics.totals.conversion_pct, 0);
});

test('sequentialCohortProblem rejects a mis-sized or empty-entry cohort, accepts a real one', async () => {
  const { sequentialCohortProblem } = await funnelP;
  const path = ['A', 'B', 'C'];
  assert.equal(sequentialCohortProblem([900, 400, 300], path, 1000), null);
  // A real funnel can legitimately lose everyone after step 1.
  assert.equal(sequentialCohortProblem([900, 0, 0], path, 1000), null);
  assert.match(sequentialCohortProblem([900, 400], path, 1000), /2 step\(s\) for a 3-step path/);
  assert.match(sequentialCohortProblem([0, 0, 0], path, 1000), /0 users at the entry step, though 1,000 users/);
  // No viewers at the entry either: zero is consistent, not a broken query.
  assert.equal(sequentialCohortProblem([0, 0, 0], path, 0), null);
});
