/* ============================================================
   atlas.ts — fetch a Revyl Atlas graph + one representative
   screenshot per screen via the `revyl` CLI, normalize it to the
   atlas-funnel atlas.json shape, and cache everything on disk.

   Node port of atlas-funnel/pull_atlas.py.
   ============================================================ */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { AtlasEdge, AtlasGraph, AtlasNode } from './types.js';

const execFileP = promisify(execFile);
const MAX_BUFFER = 256 * 1024 * 1024; // atlas graphs with many nodes get big
const SCREENSHOT_WORKERS = 4;
const SCREENSHOT_RETRIES = 3;

export interface AtlasFetchOptions {
  /** App id or name, passed straight to `revyl atlas … --app`. */
  app: string;
  /** Directory holding atlas.json + screens/<nodeId>.<ext>. */
  cacheDir: string;
  /** Ignore an existing cache and re-fetch. */
  refresh: boolean;
  /** Absolute path to the revyl CLI binary. */
  revylPath: string;
  log: (line: string) => void;
}

/* ── raw CLI payload shapes (only the fields we read) ───────── */

interface RawSemanticSummary {
  primary_purpose?: string;
  primary_actions?: string[];
  visible_labels?: string[];
}

interface RawNode {
  id: string;
  display_name?: string;
  semantic_name?: string;
  product_area?: string;
  screen_kind?: string;
  semantic_description?: string;
  observation_count?: number;
  is_entry_point?: boolean;
  is_terminal?: boolean;
  is_hub?: boolean;
  primary_actions?: string[];
  representative_observation_id?: string;
  semantic_summary?: RawSemanticSummary;
}

interface RawEdge {
  source_entity_id: string;
  target_entity_id: string;
  action_label?: string;
  action_type?: string;
  observation_count?: number;
  session_support?: number;
}

interface RawStructureNode {
  id: string;
  rank?: number;
  lane?: string;
  parent_id?: string;
  role?: string;
}

interface RawGraph {
  app_id?: string;
  app_name?: string;
  name?: string;
  stats?: Record<string, unknown>;
  nodes: RawNode[];
  edges: RawEdge[];
  structure?: { nodes?: RawStructureNode[]; map_edges?: RawEdge[] };
}

interface RawObservationPayload {
  observation?: { local_screenshot_path?: string };
  screen?: { local_screenshot_path?: string };
}

interface RawAppsPayload {
  apps?: Array<{ id?: string; name?: string }>;
}

/* ── revyl CLI plumbing ─────────────────────────────────────── */

async function runRevylJson<T>(revylPath: string, args: string[]): Promise<T> {
  let stdout: string;
  try {
    const res = await execFileP(revylPath, ['atlas', ...args, '--json'], {
      maxBuffer: MAX_BUFFER,
    });
    stdout = res.stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      throw new Error(
        `revyl CLI not found at "${revylPath}" — install it or point --revyl at the binary.`,
      );
    }
    const stderr = e.stderr ? String(e.stderr).trim().slice(0, 400) : '';
    throw new Error(
      `revyl atlas ${args.join(' ')} failed${stderr ? `:\n${stderr}` : '.'}`,
    );
  }
  try {
    // The CLI prints version nags to stderr; stdout is clean JSON.
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`revyl atlas ${args[0]} returned invalid JSON on stdout.`);
  }
}

/* ── public API ─────────────────────────────────────────────── */

/**
 * Load the normalized Atlas graph, from cache when possible.
 * Screenshot paths on the returned graph are absolute (or null).
 */
export async function loadAtlas(opts: AtlasFetchOptions): Promise<AtlasGraph> {
  const cachedPath = path.join(opts.cacheDir, 'atlas.json');
  let graph: AtlasGraph;
  if (!opts.refresh && fs.existsSync(cachedPath)) {
    opts.log(`· using cached Atlas graph (${cachedPath}) — pass --refresh to re-fetch`);
    graph = JSON.parse(fs.readFileSync(cachedPath, 'utf8')) as AtlasGraph;
    resolveScreenshotPaths(graph, opts.cacheDir);
  } else {
    graph = await fetchAtlas(opts);
  }

  // The `revyl atlas graph` payload has no app-name field, so cached
  // atlas.json files persist app_name:null. Resolve the friendly name via
  // `revyl atlas apps` on EVERY run (cache hit or not); fall back to
  // whatever the graph already carries when the lookup fails (offline /
  // unauthenticated), and the CLI falls back to the --app argument.
  const name = await resolveAppName(opts.revylPath, graph.app_id);
  if (name) {
    graph.app_name = name;
    opts.log(`· app name: ${name} (via revyl atlas apps)`);
  }
  return graph;
}

/** Look up the friendly app name for an Atlas app id. Never throws. */
async function resolveAppName(revylPath: string, appId: string): Promise<string | null> {
  try {
    const payload = await runRevylJson<RawAppsPayload>(revylPath, ['apps']);
    const apps = Array.isArray(payload.apps) ? payload.apps : [];
    const hit = apps.find(a => a && a.id === appId);
    return hit?.name || null;
  } catch {
    return null; // offline / unauthenticated — caller keeps its fallback
  }
}

async function fetchAtlas(opts: AtlasFetchOptions): Promise<AtlasGraph> {
  const { app, cacheDir, revylPath, log } = opts;
  const screensDir = path.join(cacheDir, 'screens');
  fs.mkdirSync(screensDir, { recursive: true });

  log(`→ pulling Atlas graph for "${app}"`);
  const raw = await runRevylJson<RawGraph>(revylPath, ['graph', '--app', app]);
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new Error('Atlas graph payload is missing nodes/edges — is the app id correct?');
  }
  fs.writeFileSync(path.join(cacheDir, 'atlas_raw.json'), JSON.stringify(raw, null, 1));

  // Primary spine edges (clean app structure) vs. all observed transitions.
  const primaryPairs = new Set(
    (raw.structure?.map_edges ?? []).map(e => `${e.source_entity_id}|${e.target_entity_id}`),
  );
  const structureNodes = new Map<string, RawStructureNode>(
    (raw.structure?.nodes ?? []).map(sn => [sn.id, sn]),
  );

  const nodes: AtlasNode[] = raw.nodes.map(n => {
    const ss = n.semantic_summary ?? {};
    const sn = structureNodes.get(n.id) ?? {};
    const productArea = n.product_area || 'Other';
    return {
      id: n.id,
      name: n.display_name || n.semantic_name || n.id,
      product_area: productArea,
      screen_kind: n.screen_kind ?? null,
      description: n.semantic_description || ss.primary_purpose || null,
      observation_count: n.observation_count ?? 0,
      is_entry_point: Boolean(n.is_entry_point),
      is_terminal: Boolean(n.is_terminal),
      is_hub: Boolean(n.is_hub),
      primary_actions: ss.primary_actions ?? n.primary_actions ?? [],
      visible_labels: ss.visible_labels ?? [],
      rep_observation_id: n.representative_observation_id ?? null,
      screenshot: null, // filled below
      rank: (sn as RawStructureNode).rank ?? 0,
      lane: (sn as RawStructureNode).lane || productArea,
      parent_id: (sn as RawStructureNode).parent_id ?? null,
      role: (sn as RawStructureNode).role ?? null,
    };
  });

  const edges: AtlasEdge[] = raw.edges
    .filter(e => e.source_entity_id !== e.target_entity_id)
    .map(e => ({
      source: e.source_entity_id,
      target: e.target_entity_id,
      label: e.action_label ?? null,
      action_type: e.action_type ?? null,
      observation_count: e.observation_count ?? 0,
      session_support: e.session_support ?? 0,
      is_primary: primaryPairs.has(`${e.source_entity_id}|${e.target_entity_id}`),
    }));

  log(`→ downloading ${nodes.length} screenshots (${SCREENSHOT_WORKERS} workers)…`);
  await pool(nodes, SCREENSHOT_WORKERS, async node => {
    const rel = await downloadScreenshot(revylPath, app, node, screensDir);
    node.screenshot = rel; // relative to the cache dir, for the on-disk atlas.json
    log(`   ${rel ? '✓' : '·'} ${node.name}${rel ? '' : ' (no screenshot)'}`);
  });

  const graph: AtlasGraph = {
    app_id: raw.app_id ?? app,
    app_name: raw.app_name ?? raw.name ?? null,
    stats: raw.stats ?? {},
    nodes,
    edges,
  };
  fs.writeFileSync(path.join(cacheDir, 'atlas.json'), JSON.stringify(graph, null, 1));
  log(`✓ cached Atlas graph (${nodes.length} screens, ${edges.length} transitions) → ${cacheDir}`);

  resolveScreenshotPaths(graph, cacheDir);
  return graph;
}

/* ── screenshots ────────────────────────────────────────────── */

async function downloadScreenshot(
  revylPath: string,
  app: string,
  node: AtlasNode,
  screensDir: string,
): Promise<string | null> {
  if (!node.rep_observation_id) return null;
  const tmp = path.join(screensDir, `.tmp-${node.id}`);
  fs.mkdirSync(tmp, { recursive: true });

  let local: string | null = null;
  for (let attempt = 0; attempt < SCREENSHOT_RETRIES; attempt++) {
    try {
      const payload = await runRevylJson<RawObservationPayload>(revylPath, [
        'observation', node.rep_observation_id, '--app', app, '--screenshot-dir', tmp,
      ]);
      local =
        payload.observation?.local_screenshot_path ??
        payload.screen?.local_screenshot_path ??
        null;
    } catch {
      local = null; // CLI can race under parallelism; retry
    }
    if (local && fs.existsSync(local)) break;
    local = null;
  }

  if (!local) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return null;
  }

  const ext = path.extname(local) || '.png';
  const finalAbs = path.join(screensDir, `${node.id}${ext}`);
  try {
    fs.renameSync(local, finalAbs);
  } catch {
    fs.copyFileSync(local, finalAbs);
    fs.rmSync(local, { force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return `screens/${node.id}${ext}`;
}

/** Turn cached relative screenshot paths into verified absolute ones. */
function resolveScreenshotPaths(graph: AtlasGraph, cacheDir: string): void {
  for (const node of graph.nodes) {
    if (!node.screenshot) continue;
    const abs = path.isAbsolute(node.screenshot)
      ? node.screenshot
      : path.join(cacheDir, node.screenshot);
    node.screenshot = fs.existsSync(abs) ? abs : null;
  }
}

/** Minimal promise pool — items processed by `workers` concurrent lanes. */
async function pool<T>(items: T[], workers: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  const lanes = Math.max(1, Math.min(workers, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
}
