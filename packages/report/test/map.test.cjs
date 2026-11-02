'use strict';
/* Tests for the screen-key → Atlas node mapping report (built dist/ — run
   `npm test`). */
const test = require('node:test');
const assert = require('node:assert/strict');

const mapP = import('../dist/map.js');

const node = id => ({ id, name: id, product_area: 'Test' });

test('mapScreens reports --screen-map keys that no event carried (likely typos)', async () => {
  const { mapScreens, printMappingReport } = await mapP;
  const atlas = { app_id: 'a', app_name: null, stats: {}, nodes: [node('home'), node('product')], edges: [] };
  const counts = {
    source: 'counts-file',
    screens: { '/': { users: 10, events: 10 }, '/product/[id]': { users: 5, events: 5 } },
    transitions: [],
  };
  const mapping = mapScreens(counts, atlas, {
    '/': 'home',
    '/product/:id': 'product', // typo'd key: the events say /product/[id]
  }, () => {});
  assert.deepEqual(mapping.explicitUnused, ['/product/:id']);

  const lines = [];
  printMappingReport(mapping, line => lines.push(line));
  const report = lines.join('\n');
  assert.match(report, /--screen-map keys no event carried \(1\)/);
  assert.match(report, /^ {4}\/product\/:id$/m);
});

test('a map whose keys all appear in the data reports nothing unused', async () => {
  const { mapScreens, printMappingReport } = await mapP;
  const atlas = { app_id: 'a', app_name: null, stats: {}, nodes: [node('home')], edges: [] };
  const counts = { source: 'counts-file', screens: { '/': { users: 1, events: 1 } }, transitions: [] };
  const mapping = mapScreens(counts, atlas, { '/': 'home' }, () => {});
  assert.deepEqual(mapping.explicitUnused, []);
  const lines = [];
  printMappingReport(mapping, line => lines.push(line));
  assert.doesNotMatch(lines.join('\n'), /no event carried/);
});
