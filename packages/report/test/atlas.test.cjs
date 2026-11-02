'use strict';
/* Tests for the Atlas cache loader (built dist/ — run `npm test`). No revyl
   CLI is needed: a cache hit never shells out except for the app-name lookup,
   which must fail soft when the binary is missing. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const atlasP = import('../dist/atlas.js');

function cacheWith(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cache-test-'));
  fs.writeFileSync(path.join(dir, 'atlas.json'), contents);
  return dir;
}

const load = async cacheDir => {
  const { loadAtlas } = await atlasP;
  return loadAtlas({
    app: 'app-1',
    cacheDir,
    refresh: false,
    revylPath: path.join(os.tmpdir(), 'no-such-revyl-binary'),
    log: () => {},
  });
};

test('a truncated cached atlas.json names the file and the fix', async () => {
  const dir = cacheWith('{"app_id": "app-1", "nodes": [');
  await assert.rejects(load(dir), err => {
    assert.match(err.message, /Cached Atlas graph .*atlas\.json is unreadable/);
    assert.match(err.message, /--refresh/);
    return true;
  });
});

test('a cached graph without nodes/edges or app_id is rejected up front', async () => {
  await assert.rejects(load(cacheWith('{"app_id": "app-1"}')), /malformed: it has no nodes\/edges arrays.*--refresh/);
  await assert.rejects(load(cacheWith('[]')), /malformed: it is not a JSON object/);
  await assert.rejects(load(cacheWith('{"nodes": [], "edges": []}')), /malformed: it has no app_id/);
});

test('a valid cache loads, resolving screenshots that exist and nulling ones that do not', async () => {
  const node = (id, screenshot) => ({ id, name: id, product_area: 'A', screenshot });
  const dir = cacheWith(JSON.stringify({
    app_id: 'app-1',
    app_name: 'App',
    stats: {},
    nodes: [node('a', 'screens/a.png'), node('b', 'screens/b.png')],
    edges: [],
  }));
  fs.mkdirSync(path.join(dir, 'screens'));
  fs.writeFileSync(path.join(dir, 'screens', 'a.png'), 'png');
  const graph = await load(dir);
  assert.equal(graph.app_id, 'app-1');
  assert.equal(graph.app_name, 'App', 'missing revyl binary keeps the cached name');
  assert.equal(graph.nodes[0].screenshot, path.join(dir, 'screens', 'a.png'));
  assert.equal(graph.nodes[1].screenshot, null);
});
