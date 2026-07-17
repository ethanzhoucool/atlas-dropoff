/* ============================================================
   map.ts — map PostHog `screen` keys onto Atlas nodes.

   Resolution order per key:
     1. explicit --screen-map entry (value may be node id or name)
     2. exact match on node name or node id
     3. normalized match (lowercase, separators stripped)

   Unmatched keys never crash the run — they're reported to
   stderr and simply carry no data into the report.
   ============================================================ */

import type { AtlasGraph, AtlasNode, Counts, Mapping, MatchedScreen } from './types.js';

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export function mapScreens(
  counts: Counts,
  atlas: AtlasGraph,
  explicit: Record<string, string> = {},
): Mapping {
  const byId = new Map<string, AtlasNode>(atlas.nodes.map(n => [n.id, n]));
  const byName = new Map<string, AtlasNode>();
  const byNorm = new Map<string, AtlasNode>();
  for (const n of atlas.nodes) {
    if (!byName.has(n.name)) byName.set(n.name, n);
    const key = normalize(n.name);
    if (key && !byNorm.has(key)) byNorm.set(key, n);
  }

  const resolveTarget = (target: string): AtlasNode | null =>
    byId.get(target) ?? byName.get(target) ?? byNorm.get(normalize(target)) ?? null;

  const screenToNode = new Map<string, string>();
  const matched: MatchedScreen[] = [];
  const unmatched: string[] = [];
  const explicitMisses: Mapping['explicitMisses'] = [];

  for (const key of Object.keys(counts.screens)) {
    let node: AtlasNode | null = null;
    let via: MatchedScreen['via'] = 'exact';

    const explicitTarget = explicit[key];
    if (explicitTarget !== undefined) {
      node = resolveTarget(explicitTarget);
      if (node) via = 'explicit';
      else explicitMisses.push({ key, target: explicitTarget });
    }
    if (!node) {
      node = byName.get(key) ?? byId.get(key) ?? null;
      if (node) via = 'exact';
    }
    if (!node) {
      node = byNorm.get(normalize(key)) ?? null;
      if (node) via = 'normalized';
    }

    if (node) {
      screenToNode.set(key, node.id);
      matched.push({ key, nodeId: node.id, nodeName: node.name, via });
    } else {
      unmatched.push(key);
    }
  }

  const mappedIds = new Set(screenToNode.values());
  const nodesWithoutData = atlas.nodes
    .filter(n => !mappedIds.has(n.id))
    .map(n => ({ id: n.id, name: n.name }));

  return { screenToNode, matched, unmatched, explicitMisses, nodesWithoutData };
}

/** Human-readable mapping report, one line at a time (send to stderr). */
export function printMappingReport(mapping: Mapping, log: (line: string) => void): void {
  const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length));

  log('── screen mapping ' + '─'.repeat(38));
  log(`  matched PostHog keys → Atlas nodes (${mapping.matched.length}):`);
  for (const m of mapping.matched) {
    const tag = m.via === 'normalized' ? '  (fuzzy)' : m.via === 'explicit' ? '  (--screen-map)' : '';
    log(`    ${pad(m.key, 36)} → ${m.nodeName}${tag}`);
  }
  if (mapping.explicitMisses.length) {
    log(`  ! --screen-map targets not found in Atlas (${mapping.explicitMisses.length}):`);
    for (const e of mapping.explicitMisses) log(`    ${pad(e.key, 36)} → ${e.target}`);
  }
  if (mapping.unmatched.length) {
    log(`  ! unmatched PostHog keys (${mapping.unmatched.length}) — carry no data into the report:`);
    for (const key of mapping.unmatched) log(`    ${key}`);
  }
  if (mapping.nodesWithoutData.length) {
    log(`  · Atlas screens with no analytics data (${mapping.nodesWithoutData.length}):`);
    for (const n of mapping.nodesWithoutData) log(`    ${n.name}`);
  }
  log('─'.repeat(56));
}
