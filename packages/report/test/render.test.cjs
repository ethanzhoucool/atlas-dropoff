'use strict';
/* Tests for the single-file HTML report (built dist/ — run `npm test`).
   Every name in it comes from somewhere untrusted: Atlas node names and
   descriptions are model-generated, and screen keys / app names come from the
   app's own analytics. None of them may escape into markup. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const funnelP = import('../dist/funnel.js');
const mapP = import('../dist/map.js');
const renderP = import('../dist/render.js');

const HOSTILE = '</script><script>window.__pwned=1</script><!--';
const HOSTILE_DESC = '<img src=x onerror="window.__pwned=2">';

function node(id, name, extra = {}) {
  return {
    id,
    name,
    product_area: '"><svg onload=alert(3)>',
    screen_kind: null,
    description: HOSTILE_DESC,
    observation_count: 1,
    is_entry_point: false,
    is_terminal: false,
    is_hub: false,
    primary_actions: [],
    visible_labels: [],
    rep_observation_id: null,
    screenshot: null,
    rank: 0,
    lane: 'x',
    parent_id: null,
    role: null,
    ...extra,
  };
}

async function renderHostile() {
  const { mapScreens } = await mapP;
  const { buildNodeTransitions, computeAnalytics } = await funnelP;
  const { renderReport } = await renderP;
  const atlas = {
    app_id: 'app/../x?y=1#z',
    app_name: null,
    stats: {},
    nodes: [
      node('n"1', HOSTILE, { is_entry_point: true }),
      node('n2', 'Checkout <b>now</b>'),
    ],
    edges: [
      {
        source: 'n"1', target: 'n2', label: '<script>alert(4)</script>', action_type: null,
        observation_count: 1, session_support: 1, is_primary: true,
      },
    ],
  };
  const counts = {
    source: 'counts-file',
    screens: { a: { users: 100, events: 120 }, b: { users: 40, events: 40 } },
    transitions: [{ src: 'a', dst: 'b', users: 40 }],
  };
  const mapping = mapScreens(counts, atlas, { a: 'n"1', b: 'n2' }, () => {});
  const transitions = buildNodeTransitions(counts, mapping);
  const analytics = computeAnalytics(atlas, counts, mapping, transitions, {
    dateRange: 'Last <28> days',
    disclaimer: HOSTILE,
    warn: () => {},
  });
  const html = renderReport(atlas, analytics, transitions, {
    appName: '</title><script>window.__pwned=5</script>',
    sourceLabel: '<i>pill</i>',
  });
  return { html, atlas };
}

/** The inline `window.FLOWMAP = {...};` payload, parsed back. */
function payloadOf(html) {
  const m = html.match(/<script>window\.FLOWMAP = (.*?);<\/script>/s);
  assert.ok(m, 'payload script present');
  return JSON.parse(m[1]);
}

test('untrusted names cannot open or close a <script> block', async () => {
  const { html } = await renderHostile();
  // Exactly the two script blocks the template writes: payload + viewer JS.
  assert.equal((html.match(/<script\b/gi) || []).length, 2);
  assert.equal((html.match(/<\/script>/gi) || []).length, 2);
  assert.ok(!html.includes('<!--'), 'no comment opener smuggled in');
  // The payload is <-escaped, yet decodes back to the exact original strings.
  const payload = payloadOf(html);
  assert.equal(payload.nodes.find(n => n.id === 'n"1').name, HOSTILE);
  assert.equal(payload.nodes.find(n => n.id === 'n2').description, HOSTILE_DESC);
  assert.equal(payload.disclaimer, HOSTILE);
});

test('server-rendered text (title, app name, source pill) is HTML-escaped', async () => {
  const { html } = await renderHostile();
  assert.match(html, /<title>Atlas Drop-off · &lt;\/title&gt;&lt;script&gt;window\.__pwned=5&lt;\/script&gt;<\/title>/);
  assert.match(html, /class="brand-sub">&lt;\/title&gt;&lt;script&gt;/);
  assert.match(html, />&lt;i&gt;pill&lt;\/i&gt;<\/span>/);
});

test('the Atlas viewer link encodes the app id instead of splicing it into the path', async () => {
  const { html } = await renderHostile();
  assert.equal(
    payloadOf(html).app.viewer,
    'https://app.revyl.ai/apps/app%2F..%2Fx%3Fy%3D1%23z/atlas',
  );
});

test('the viewer JS reads untrusted strings only through textContent', async () => {
  const { html } = await renderHostile();
  const js = html.match(/<script>\s*('use strict';.*?)<\/script>/s)[1];
  // The only innerHTML writes allowed: elHtml() (used solely for the two
  // hard-coded labels with numeric interpolation) and clearing the drawer.
  // Anything else would be an injection sink for Atlas/analytics strings.
  const sinks = (js.match(/[\w.]+\.innerHTML\s*=\s*[^=;]+/g) || []).map(s => s.replace(/\s+/g, ' '));
  assert.deepEqual(sinks.sort(), ["dbody.innerHTML = ''", 'n.innerHTML = h']);
  assert.equal((js.match(/elHtml\(/g) || []).length, 3, 'definition + the two numeric labels');
  assert.ok(!/insertAdjacentHTML|outerHTML\s*=|document\.write/.test(js));
});

test('user counts abbreviate cleanly at the k / M rounding edges', async () => {
  const { html } = await renderHostile();
  const src = html.match(/function fmt\(n\) \{[\s\S]*?\n\}/);
  assert.ok(src, 'fmt() present in the viewer JS');
  const fmt = vm.runInNewContext(`(${src[0]})`);
  const cases = [
    [0, '0'], [7, '7'], [999, '999'], [999.4, '999'], [999.5, '1k'],
    [1000, '1k'], [1234, '1.2k'], [12_345, '12.3k'], [999_949, '999.9k'],
    [999_950, '1M'], [1_000_000, '1M'], [1_500_000, '1.5M'], [12_340_000, '12.3M'],
  ];
  for (const [n, want] of cases) assert.equal(fmt(n), want, `fmt(${n})`);
});
