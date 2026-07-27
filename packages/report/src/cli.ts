#!/usr/bin/env node
/* ============================================================
   atlas-report — join a Revyl Atlas screen map with atlas_screen
   events from your analytics vendor (PostHog, Amplitude, Mixpanel,
   or an offline file) and render a single self-contained HTML
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
import { renderReport } from './render.js';
import { SOURCE_NAMES, chooseSourceName, createSource } from './sources/index.js';
import type { CountsSource } from './sources/index.js';
import type { Counts } from './types.js';
import { isLiveSource } from './types.js';

const VERSION = '0.2.0';
const DEFAULT_OUT = 'atlas-dropoff-report.html';
const DEFAULT_REVYL = '~/.revyl/bin/revyl';

const HELP = `atlas-report ${VERSION}
Join a Revyl Atlas screen map with atlas_screen events from your analytics
vendor and render a single self-contained HTML drop-off report.

USAGE
  atlas-report generate --app <atlas-app-id-or-name> [options]

SOURCE
  --source <name>       ${SOURCE_NAMES.join(' | ')}
                        Default: the one vendor whose credentials are set,
                        else posthog. "counts"/"events" are offline files.
  --project <id>        PostHog project id / Mixpanel project id
  --host <url>          Query API host for the chosen vendor
  --region <us|eu>      Vendor data region (default: us)
  --counts <file>       Offline: precomputed counts JSON (counts.example.json)
  --events <file>       Offline: raw events JSONL (events.example.jsonl).
                        Supports the exact sequential funnel.
  --max-events <n>      Cap events read from Mixpanel/--events (default: 2000000)

OPTIONS
  --app <id|name>       Revyl Atlas app id or name (required)
  --days <n>            Lookback window in days, 1-3650 (default: 28)
  --timeout <s>         Per-query timeout in seconds (default: 60)
  --funnel-window <s>   Sequential-funnel conversion window in seconds
                        (live mode; default: the full lookback, days*86400)
  --screen-map <file>   JSON map of event screen keys -> Atlas node id/name
  --out <file>          Output HTML path (default: ${DEFAULT_OUT})
  --atlas-cache <dir>   Atlas graph + screenshot cache (default: .atlas-cache/<app>)
  --refresh             Ignore the cache and re-fetch the Atlas graph
  --revyl <path>        Path to the revyl CLI (default: ${DEFAULT_REVYL})
  -h, --help            Show this help
  -v, --version         Print the version

ENVIRONMENT
  PostHog     POSTHOG_PERSONAL_API_KEY (query:read), POSTHOG_PROJECT_ID, POSTHOG_HOST
  Amplitude   AMPLITUDE_API_KEY, AMPLITUDE_SECRET_KEY, AMPLITUDE_HOST
  Mixpanel    MIXPANEL_SERVICE_ACCOUNT, MIXPANEL_SERVICE_SECRET,
              MIXPANEL_PROJECT_ID, MIXPANEL_HOST

EXAMPLES
  # PostHog
  POSTHOG_PERSONAL_API_KEY=phx_... atlas-report generate --app parrot --project 12345

  # Amplitude
  AMPLITUDE_API_KEY=... AMPLITUDE_SECRET_KEY=... atlas-report generate --app parrot

  # Mixpanel
  MIXPANEL_SERVICE_ACCOUNT=... MIXPANEL_SERVICE_SECRET=... \\
    atlas-report generate --app parrot --project 3141592

  # offline: no credentials needed
  atlas-report generate --app parrot --counts counts.example.json
`;

/* ── arg parsing (hand-rolled; zero runtime deps) ───────────── */

interface CliOptions {
  app?: string;
  source?: string;
  project?: string;
  host?: string;
  region?: 'us' | 'eu';
  days: number;
  /** Query timeout in seconds. */
  timeout: number;
  /** Sequential-funnel window in seconds (live mode); defaults to days*86400. */
  funnelWindow?: number;
  screenMap?: string;
  out: string;
  atlasCache?: string;
  refresh: boolean;
  counts?: string;
  events?: string;
  maxEvents?: number;
  revyl: string;
}

const VALUE_FLAGS = new Set([
  '--app', '--source', '--project', '--host', '--region', '--days', '--timeout',
  '--funnel-window', '--screen-map', '--out', '--atlas-cache', '--counts',
  '--events', '--max-events', '--revyl',
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

  const positiveInt = (flag: string, value: string, max: number): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      fail(`${flag} must be an integer between 1 and ${max} (got "${value}").`);
    }
    return n;
  };

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
        case '--source': {
          if (!(SOURCE_NAMES as readonly string[]).includes(value)) {
            fail(`--source must be one of: ${SOURCE_NAMES.join(', ')} (got "${value}").`);
          }
          opts.source = value;
          break;
        }
        case '--project': opts.project = value; break;
        case '--host': opts.host = value; break;
        case '--region': {
          if (value !== 'us' && value !== 'eu') {
            fail(`--region must be "us" or "eu" (got "${value}").`);
          }
          opts.region = value;
          break;
        }
        case '--days': opts.days = positiveInt('--days', value, 3650); break;
        case '--timeout': opts.timeout = positiveInt('--timeout', value, 3600); break;
        case '--funnel-window': {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) {
            fail(`--funnel-window must be a positive integer number of seconds (got "${value}").`);
          }
          opts.funnelWindow = n;
          break;
        }
        case '--max-events': opts.maxEvents = positiveInt('--max-events', value, 1e9); break;
        case '--screen-map': opts.screenMap = value; break;
        case '--out': opts.out = value; break;
        case '--atlas-cache': opts.atlasCache = value; break;
        case '--counts': opts.counts = value; break;
        case '--events': opts.events = value; break;
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
    fail(`Screen map "${file}" must be a JSON object of { "<event screen key>": "<atlas node id or name>" }.`);
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

/** Human name for the source, used in log lines and the report disclaimer. */
const VENDOR_LABEL: Record<string, string> = {
  posthog: 'PostHog',
  amplitude: 'Amplitude',
  mixpanel: 'Mixpanel',
  'counts-file': 'the counts file',
  'events-file': 'the events file',
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

  /* 2 — counts, from whichever analytics source is configured */
  const selection = {
    source: opts.source,
    counts: opts.counts,
    events: opts.events,
    project: opts.project,
    host: opts.host,
    region: opts.region,
    days: opts.days,
    timeoutMs: opts.timeout * 1000,
    maxEvents: opts.maxEvents,
    appId: atlas.app_id, // canonical Atlas app id, matches `atlas_app_id`
    env: process.env,
    log,
  };
  let source: CountsSource;
  let counts: Counts;
  try {
    const chosen = chooseSourceName(selection);
    if (chosen.why === 'env') {
      log(`· source: ${chosen.name} (only vendor with credentials set — override with --source)`);
    }
    source = createSource(selection);
    const vendor = VENDOR_LABEL[source.id] ?? source.id;
    log(
      isLiveSource(source.id)
        ? `→ querying ${vendor} (last ${opts.days} days)…`
        : `→ reading ${opts.counts ?? opts.events}…`,
    );
    counts = await source.fetchCounts();
    log(
      `· ${vendor}: ${Object.keys(counts.screens).length} screens, ` +
      `${counts.transitions.length} transitions with data`,
    );
  } catch (err) {
    fail((err as Error).message);
  }
  if (!counts.leavers || Object.keys(counts.leavers).length === 0) {
    log('· no "leavers" data — exit rates use the per-destination sum approximation (can bias low)');
  }

  /* 3 — map event screen keys onto Atlas nodes */
  const explicit = opts.screenMap ? loadScreenMapFile(opts.screenMap) : {};
  const mapping = mapScreens(counts, atlas, explicit);
  printMappingReport(mapping, log);

  /* 4 — drop-off compute */
  const transitions = buildNodeTransitions(counts, mapping);
  const dateRange = counts.date_range ?? `Last ${opts.days} days`;

  // Sources that keep per-user data (PostHog's windowFunnel, Amplitude's
  // funnel API, the locally-computed Mixpanel/events streams) answer the exact
  // sequential question. The rest fall back to the min-cohort estimate.
  let funnelPath: string[] | undefined;
  let sequentialCohort: number[] | undefined;
  if (source.fetchFunnel) {
    const { users, keysByNode } = nodeUsersFromCounts(counts, mapping);
    const byId = new Map(atlas.nodes.map(n => [n.id, n]));
    const p = buildFunnelPath(atlas, byId, users, transitions);
    const stepKeys = p.map(id => keysByNode.get(id) ?? []);
    if (p.length >= 2 && stepKeys.every(k => k.length > 0)) {
      const windowSeconds = opts.funnelWindow ?? opts.days * 86400;
      try {
        log(`→ running the sequential funnel (${p.length} steps, ${opts.funnelWindow ? `${windowSeconds}s` : `${opts.days}d`} window)…`);
        sequentialCohort = await source.fetchFunnel(stepKeys, windowSeconds);
        funnelPath = p;
      } catch (err) {
        log(`! sequential funnel unavailable (${(err as Error).message}) — using the min-cohort estimate.`);
      }
    }
  }

  const vendor = VENDOR_LABEL[source.id] ?? source.id;
  const provenance = isLiveSource(source.id)
    ? `Distinct-user counts from ${vendor} atlas_screen events (${dateRange.toLowerCase()}), joined onto the Revyl Atlas screen graph.`
    : `Counts loaded from ${opts.counts ?? opts.events} (offline mode), joined onto the Revyl Atlas screen graph.`;
  const method = sequentialCohort !== undefined
    ? ' End-to-end conversion is a real sequential funnel over the discovered path.'
    : ' Funnel conversion uses a monotone min-cohort estimate over per-step transition counts — an upper bound on true end-to-end traversal.';

  const analytics = computeAnalytics(atlas, counts, mapping, transitions, {
    dateRange, disclaimer: provenance + method, path: funnelPath, sequentialCohort,
  });

  /* 5 — render the single-file report */
  const appName = atlas.app_name ?? app;
  const html = renderReport(atlas, analytics, transitions, {
    appName,
    sourceLabel: source.label,
  });
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
