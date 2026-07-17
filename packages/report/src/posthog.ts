/* ============================================================
   posthog.ts — HogQL queries against the PostHog query API,
   plus the offline --counts file loader.

   Event contract (frozen, emitted by the atlas-analytics SDK):
     event: "atlas_screen"
     properties: screen, screen_title, prev_screen (string|null),
                 atlas_app_id, session_id, distinct_id, sdk, sdk_version
   ============================================================ */

import * as fs from 'node:fs';
import type { Counts, ScreenCount, TransitionCount } from './types.js';

export interface PostHogOptions {
  /** Query API host, e.g. https://us.posthog.com (capture host differs). */
  host: string;
  projectId: string;
  apiKey: string;
  /** Canonical Atlas app id — matched against properties.atlas_app_id. */
  appId: string;
  days: number;
  /** Per-query HTTP timeout in milliseconds (default 60000). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/* ── HogQL ──────────────────────────────────────────────────── */

function assertDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error(`--days must be an integer between 1 and 3650 (got ${days}).`);
  }
}

/**
 * Distinct users + raw events per screen key. `{app_id}` is bound via `values`.
 * Uniques use `person_id` (person-on-events), not `distinct_id` — one
 * identified person spans multiple pre-identify device ids, so counting
 * distinct_id over-counts unique users.
 */
export function screensQuery(days: number): string {
  assertDays(days);
  return [
    'SELECT properties.screen AS screen,',
    '       count(DISTINCT person_id) AS users,',
    '       count() AS events',
    'FROM events',
    "WHERE event = 'atlas_screen'",
    '  AND properties.atlas_app_id = {app_id}',
    `  AND timestamp > now() - INTERVAL ${days} DAY`,
    'GROUP BY screen',
    'ORDER BY users DESC',
  ].join('\n');
}

/** Distinct users per (prev_screen → screen) transition. */
export function transitionsQuery(days: number): string {
  assertDays(days);
  return [
    'SELECT properties.prev_screen AS src,',
    '       properties.screen AS dst,',
    '       count(DISTINCT person_id) AS users',
    'FROM events',
    "WHERE event = 'atlas_screen'",
    '  AND properties.atlas_app_id = {app_id}',
    '  AND properties.prev_screen IS NOT NULL',
    "  AND properties.prev_screen != ''",
    `  AND timestamp > now() - INTERVAL ${days} DAY`,
    'GROUP BY src, dst',
    'ORDER BY users DESC',
  ].join('\n');
}

/**
 * Distinct users who navigated FROM each screen to any next screen
 * ("leavers"). exit_rate = 1 − leavers/users; summing the per-destination
 * transition counts instead would double-count a user who left to two
 * destinations and bias exit rates low.
 */
export function leaversQuery(days: number): string {
  assertDays(days);
  return [
    'SELECT properties.prev_screen AS src,',
    '       count(DISTINCT person_id) AS leavers',
    'FROM events',
    "WHERE event = 'atlas_screen'",
    '  AND properties.atlas_app_id = {app_id}',
    "  AND properties.prev_screen != ''",
    `  AND timestamp > now() - INTERVAL ${days} DAY`,
    'GROUP BY src',
  ].join('\n');
}

async function runHogQL(opts: PostHogOptions, sql: string): Promise<unknown[][]> {
  const url = `${opts.host.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(opts.projectId)}/query/`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: {
          kind: 'HogQLQuery',
          query: sql,
          // Proper parameterization: {app_id} is bound server-side as a
          // constant, so app ids never get spliced into SQL text.
          values: { app_id: opts.appId },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(
        `PostHog query timed out after ${Math.round(timeoutMs / 1000)}s — ` +
        'check --host or run offline with --counts <file>.',
      );
    }
    throw new Error(
      `Could not reach PostHog at ${url} (${e.message}). ` +
      'Check --host / your network, or run offline with --counts <file>.',
    );
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 400);
    const hint =
      res.status === 401 || res.status === 403
        ? 'Check POSTHOG_PERSONAL_API_KEY (needs query:read scope).'
        : res.status === 404
          ? 'Check --project / POSTHOG_PROJECT_ID.'
          : 'Or run offline with --counts <file>.';
    throw new Error(`PostHog query failed: ${res.status} ${res.statusText} at ${url}\n${body}\n${hint}`);
  }
  let json: { results?: unknown[][] };
  try {
    json = (await res.json()) as { results?: unknown[][] };
  } catch {
    throw new Error(
      `Unexpected non-JSON response from ${opts.host} — is this really the ` +
      'PostHog query API host? (The capture host, e.g. us.i.posthog.com, is different.)',
    );
  }
  if (!Array.isArray(json.results)) {
    throw new Error('PostHog query response had no `results` array — unexpected payload shape.');
  }
  return json.results;
}

function toCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Run the HogQL queries and normalize into the shared Counts shape. */
export async function fetchCounts(opts: PostHogOptions): Promise<Counts> {
  const [screenRows, transitionRows, leaverRows] = await Promise.all([
    runHogQL(opts, screensQuery(opts.days)),
    runHogQL(opts, transitionsQuery(opts.days)),
    runHogQL(opts, leaversQuery(opts.days)),
  ]);

  const screens: Record<string, ScreenCount> = {};
  for (const row of screenRows) {
    const key = row[0];
    if (typeof key !== 'string' || key === '') continue;
    screens[key] = { users: toCount(row[1]), events: toCount(row[2]) };
  }
  if (Object.keys(screens).length === 0) {
    throw new Error(
      `PostHog returned 0 atlas_screen events for atlas_app_id=${opts.appId} ` +
      `in the last ${opts.days} days — check the app id, project, and time window.`,
    );
  }

  const transitions: TransitionCount[] = [];
  for (const row of transitionRows) {
    const src = row[0];
    const dst = row[1];
    if (typeof src !== 'string' || src === '' || typeof dst !== 'string' || dst === '') continue;
    transitions.push({ src, dst, users: toCount(row[2]) });
  }

  const leavers: Record<string, number> = {};
  for (const row of leaverRows) {
    const src = row[0];
    if (typeof src !== 'string' || src === '') continue;
    leavers[src] = toCount(row[1]);
  }

  return { source: 'posthog', screens, transitions, leavers };
}

/* ── offline counts file ────────────────────────────────────── */

/**
 * Load a --counts file. Schema:
 * {
 *   "date_range": "Last 28 days",              // optional label
 *   "screens": { "<screenKey>": { "users": N, "events": N } },
 *   "transitions": [ { "src": "<key>", "dst": "<key>", "users": N } ],
 *   "leavers": { "<screenKey>": N }            // optional: distinct users who
 * }                                            // navigated FROM the screen
 * `events` defaults to `users` when omitted; `transitions` may be empty.
 * When `leavers` is absent, exit rates fall back to the per-destination
 * sum approximation (which can double-count multi-destination users).
 */
export function loadCountsFile(file: string): Counts {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read counts file "${file}": ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Counts file "${file}" must be a JSON object (see counts.example.json).`);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.screens !== 'object' || obj.screens === null || Array.isArray(obj.screens)) {
    throw new Error(`Counts file "${file}" is missing the "screens" object.`);
  }
  const screens: Record<string, ScreenCount> = {};
  for (const [key, val] of Object.entries(obj.screens as Record<string, unknown>)) {
    if (typeof val !== 'object' || val === null) {
      throw new Error(`Counts file: screens["${key}"] must be an object { users, events }.`);
    }
    const entry = val as Record<string, unknown>;
    const users = toCount(entry.users);
    const events = entry.events === undefined ? users : toCount(entry.events);
    screens[key] = { users, events };
  }

  const transitions: TransitionCount[] = [];
  if (obj.transitions !== undefined) {
    if (!Array.isArray(obj.transitions)) {
      throw new Error(`Counts file: "transitions" must be an array.`);
    }
    for (const [i, val] of (obj.transitions as unknown[]).entries()) {
      if (typeof val !== 'object' || val === null) {
        throw new Error(`Counts file: transitions[${i}] must be an object { src, dst, users }.`);
      }
      const t = val as Record<string, unknown>;
      if (typeof t.src !== 'string' || typeof t.dst !== 'string') {
        throw new Error(`Counts file: transitions[${i}] needs string "src" and "dst".`);
      }
      transitions.push({ src: t.src, dst: t.dst, users: toCount(t.users) });
    }
  }

  let leavers: Record<string, number> | undefined;
  if (obj.leavers !== undefined) {
    if (typeof obj.leavers !== 'object' || obj.leavers === null || Array.isArray(obj.leavers)) {
      throw new Error(`Counts file: "leavers" must be an object of { "<screenKey>": distinctUsers }.`);
    }
    leavers = {};
    for (const [key, val] of Object.entries(obj.leavers as Record<string, unknown>)) {
      leavers[key] = toCount(val);
    }
  }

  return {
    source: 'counts-file',
    date_range: typeof obj.date_range === 'string' ? obj.date_range : undefined,
    screens,
    transitions,
    leavers,
  };
}
