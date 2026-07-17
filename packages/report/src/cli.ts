#!/usr/bin/env node
/* ============================================================
   atlas-report — join a Revyl Atlas screen map with PostHog
   atlas_screen events and render a single self-contained HTML
   drop-off report.
   ============================================================ */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAtlas } from './atlas.js';
import {
  buildFunnelPath, buildNodeTransitions, computeAnalytics, nodeUsersFromCounts,
} from './funnel.js';
import { mapScreens, printMappingReport } from './map.js';
import { fetchCounts, fetchFunnel, loadCountsFile, type PostHogOptions } from './posthog.js';
import { renderReport } from './render.js';
import type { Counts } from './types.js';

const VERSION = '0.1.0';
const DEFAULT_HOST = 'https://us.posthog.com';
const DEFAULT_OUT = 'atlas-dropoff-report.html';
const DEFAULT_REVYL = '~/.revyl/bin/revyl';

const HELP = `atlas-report ${VERSION}
Join a Revyl Atlas screen map with PostHog atlas_screen events and render a
single self-contained HTML drop-off report.

USAGE
  atlas-report generate --app <atlas-app-id-or-name> [options]

OPTIONS
  --app <id|name>       Revyl Atlas app id or name (required)
  --project <id>        PostHog project id (default: $POSTHOG_PROJECT_ID)
  --host <url>          PostHog query API host (default: $POSTHOG_HOST or
                        ${DEFAULT_HOST})
  --days <n>            Lookback window in days, 1-3650 (default: 28)
  --timeout <s>         PostHog query timeout in seconds (default: 60)
  --funnel-window <s>   Sequential-funnel conversion window in seconds
                        (live mode; default: the full lookback, days*86400)
  --screen-map <file>   JSON map of PostHog screen keys -> Atlas node id/name
  --out <file>          Output HTML path (default: ${DEFAULT_OUT})
  --atlas-cache <dir>   Atlas graph + screenshot cache (default: .atlas-cache/<app>)
  --refresh             Ignore the cache and re-fetch the Atlas graph
  --counts <file>       Offline mode: read precomputed counts JSON instead of
                        querying PostHog (see counts.example.json)
  --revyl <path>        Path to the revyl CLI (default: ${DEFAULT_REVYL})
  -h, --help            Show this help
  -v, --version         Print the version

ENVIRONMENT
  POSTHOG_PERSONAL_API_KEY  Personal API key for the PostHog query API
                            (required unless --counts is used)
  POSTHOG_PROJECT_ID        Default for --project
  POSTHOG_HOST              Default for --host

EXAMPLES
  # live: query PostHog and render
  POSTHOG_PERSONAL_API_KEY=phx_... atlas-report generate --app parrot --project 12345

  # offline: no PostHog key needed
  atlas-report generate --app parrot --counts counts.example.json
`;

/* ── arg parsing (hand-rolled; zero runtime deps) ───────────── */

interface CliOptions {
  app?: string;
  project?: string;
  host?: string;
  days: number;
  /** PostHog query timeout in seconds. */
  timeout: number;
  /** Sequential-funnel window in seconds (live mode); defaults to days*86400. */
  funnelWindow?: number;
  screenMap?: string;
  out: string;
  atlasCache?: string;
  refresh: boolean;
  counts?: string;
  revyl: string;
}

const VALUE_FLAGS = new Set([
  '--app', '--project', '--host', '--days', '--timeout', '--funnel-window',
  '--screen-map', '--out', '--atlas-cache', '--counts', '--revyl',
]);
const BOOL_FLAGS = new Set(['--refresh', '-h', '--help', '-v', '--version']);

function fail(message: string): never {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    days: 28,
    timeout: 60,
    out: DEFAULT_OUT,
    refresh: false,
    revyl: DEFAULT_REVYL,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (arg === '-v' || arg === '--version') {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    }
    if (arg === '--refresh') {
      opts.refresh = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      // Any following token that looks like a flag (starts with "--", or is a
      // known boolean flag) means the value is missing — this also catches
      // typos like `--app --projct`, which would otherwise be swallowed.
      if (value === undefined || value.startsWith('--') || BOOL_FLAGS.has(value)) {
        fail(`${arg} needs a value.`);
      }
      i++;
      switch (arg) {
        case '--app': opts.app = value; break;
        case '--project': opts.project = value; break;
        case '--host': opts.host = value; break;
        case '--days': {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1 || n > 3650) {
            fail(`--days must be an integer between 1 and 3650 (got "${value}").`);
          }
          opts.days = n;
          break;
        }
        case '--timeout': {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1 || n > 3600) {
            fail(`--timeout must be an integer between 1 and 3600 seconds (got "${value}").`);
          }
          opts.timeout = n;
          break;
        }
        case '--funnel-window': {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) {
            fail(`--funnel-window must be a positive integer number of seconds (got "${value}").`);
          }
          opts.funnelWindow = n;
          break;
        }
        case '--screen-map': opts.screenMap = value; break;
        case '--out': opts.out = value; break;
        case '--atlas-cache': opts.atlasCache = value; break;
        case '--counts': opts.counts = value; break;
        case '--revyl': opts.revyl = value; break;
      }
      continue;
    }
    if (arg.startsWith('-')) fail(`Unknown option "${arg}". Run atlas-report --help.`);
    positionals.push(arg);
  }

  if (positionals.length === 0) {
    if (argv.length === 0) {
      process.stdout.write(HELP);
      process.exit(0);
    }
    fail('Missing command — run "atlas-report generate --app <id|name>".');
  }
  if (positionals[0] !== 'generate' || positionals.length > 1) {
    fail(`Unknown command "${positionals.join(' ')}" — the only command is "generate".`);
  }
  return opts;
}

/* ── helpers ────────────────────────────────────────────────── */

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function sanitizeForPath(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function loadScreenMapFile(file: string): Record<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`Could not read screen map "${file}": ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`Screen map "${file}" must be a JSON object of { "<posthog screen>": "<atlas node id or name>" }.`);
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== 'string') fail(`Screen map "${file}": value for "${key}" must be a string.`);
    out[key] = val;
  }
  return out;
}

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/* ── main ───────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.app) fail('--app is required (Revyl Atlas app id or name).');
  const app = opts.app;

  /* 1 — Atlas graph + screenshots (cached) */
  const cacheDir = path.resolve(opts.atlasCache ?? path.join('.atlas-cache', sanitizeForPath(app)));
  const atlas = await loadAtlas({
    app,
    cacheDir,
    refresh: opts.refresh,
    revylPath: expandTilde(opts.revyl),
    log,
  });
  const shots = atlas.nodes.filter(n => n.screenshot).length;
  log(`· Atlas: ${atlas.nodes.length} screens, ${atlas.edges.length} transitions, ${shots} screenshots`);

  /* 2 — counts: live PostHog query, or the offline --counts file */
  let counts: Counts;
  let pgOpts: PostHogOptions | undefined;
  if (opts.counts) {
    counts = loadCountsFile(opts.counts);
    log(`· counts: ${Object.keys(counts.screens).length} screens, ${counts.transitions.length} transitions (offline file ${opts.counts})`);
    if (!counts.leavers) {
      log('· counts file has no "leavers" — exit rates use the per-destination sum approximation (can bias low)');
    }
  } else {
    const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
    if (!apiKey) {
      fail(
        'POSTHOG_PERSONAL_API_KEY is not set. Export a PostHog personal API key ' +
        '(query:read scope), or run offline with --counts <file> — see counts.example.json.',
      );
    }
    const projectId = opts.project ?? process.env.POSTHOG_PROJECT_ID;
    if (!projectId) fail('No PostHog project id — pass --project or set POSTHOG_PROJECT_ID.');
    const host = opts.host ?? process.env.POSTHOG_HOST ?? DEFAULT_HOST;
    log(`→ querying PostHog (project ${projectId}, last ${opts.days} days)…`);
    pgOpts = {
      host,
      projectId,
      apiKey,
      appId: atlas.app_id, // canonical Atlas app id, matches properties.atlas_app_id
      days: opts.days,
      timeoutMs: opts.timeout * 1000,
    };
    counts = await fetchCounts(pgOpts);
    log(`· PostHog: ${Object.keys(counts.screens).length} screens, ${counts.transitions.length} transitions with data`);
  }

  /* 3 — map PostHog screen keys onto Atlas nodes */
  const explicit = opts.screenMap ? loadScreenMapFile(opts.screenMap) : {};
  const mapping = mapScreens(counts, atlas, explicit);
  printMappingReport(mapping, log);

  /* 4 — drop-off compute */
  const transitions = buildNodeTransitions(counts, mapping);
  const dateRange = counts.date_range ?? `Last ${opts.days} days`;

  // Live mode: run a real sequential funnel (HogQL windowFunnel) over the
  // discovered path for exact end-to-end conversion. Offline mode has no
  // per-user data, so computeAnalytics uses the monotone min-cohort estimate.
  let funnelPath: string[] | undefined;
  let sequentialCohort: number[] | undefined;
  if (pgOpts && counts.source === 'posthog') {
    const { users, keysByNode } = nodeUsersFromCounts(counts, mapping);
    const byId = new Map(atlas.nodes.map(n => [n.id, n]));
    const p = buildFunnelPath(atlas, byId, users, transitions);
    const stepKeys = p.map(id => keysByNode.get(id) ?? []);
    if (p.length >= 2 && stepKeys.every(k => k.length > 0)) {
      const windowSeconds = opts.funnelWindow ?? opts.days * 86400;
      try {
        log(`→ querying PostHog funnel (${p.length} steps, ${opts.funnelWindow ? `${windowSeconds}s` : `${opts.days}d`} window)…`);
        sequentialCohort = await fetchFunnel(pgOpts, stepKeys, windowSeconds);
        funnelPath = p;
      } catch (err) {
        log(`! funnel query failed (${(err as Error).message}) — using the min-cohort estimate.`);
      }
    }
  }

  const sequential = sequentialCohort !== undefined;
  const disclaimer = sequential
    ? `Distinct-person counts from PostHog atlas_screen events (${dateRange.toLowerCase()}), joined onto the Revyl Atlas screen graph. End-to-end conversion is a real sequential funnel (HogQL windowFunnel) over the discovered path.`
    : counts.source === 'posthog'
      ? `Distinct-person counts from PostHog atlas_screen events (${dateRange.toLowerCase()}), joined onto the Revyl Atlas screen graph. Funnel conversion uses a monotone min-cohort estimate over per-step transition counts — an upper bound on true end-to-end traversal.`
      : `Counts loaded from ${opts.counts} (offline mode) — same schema the live PostHog query produces, joined onto the Revyl Atlas screen graph. Funnel conversion is a monotone min-cohort estimate from pairwise per-step counts — an upper bound on true end-to-end path traversal.`;

  const analytics = computeAnalytics(atlas, counts, mapping, transitions, {
    dateRange, disclaimer, path: funnelPath, sequentialCohort,
  });

  /* 5 — render the single-file report */
  const appName = atlas.app_name ?? app;
  const html = renderReport(atlas, analytics, transitions, { appName });
  const outPath = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);

  const sizeMb = (Buffer.byteLength(html) / (1024 * 1024)).toFixed(1);
  const t = analytics.totals;
  log(`✓ wrote ${outPath} (${sizeMb} MB)`);
  log(`  funnel: ${analytics.funnel.length} steps · ${t.sessions.toLocaleString('en-US')} users entered · ${t.conversion_pct}% converted`);
  if (t.biggest_leak) {
    log(`  biggest leak: ${t.biggest_leak.from_label} → ${t.biggest_leak.to_label} (−${Math.round(t.biggest_leak.drop_pct * 100)}%)`);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
