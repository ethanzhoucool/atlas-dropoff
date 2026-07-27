/* ============================================================
   amplitude.ts — Amplitude Dashboard REST API source.

   Three segmentation queries (the same three the HogQL source
   runs) plus one funnel query:

     screens      GET /api/2/events/segmentation  group_by screen
     transitions  GET /api/2/events/segmentation  group_by prev_screen, screen
     leavers      GET /api/2/events/segmentation  group_by prev_screen
     funnel       GET /api/2/funnels              mode=ordered, cs=<window>

   Uniques come from `seriesCollapsed`, which is Amplitude's
   deduplicated total across the whole range — summing the daily
   `series` values instead would double-count anyone who returned.
   ============================================================ */

import type { Counts, ScreenCount, TransitionCount } from '../types.js';
import type { CountsSource, WindowOptions } from './types.js';
import {
  DEFAULT_TIMEOUT_MS, basicAuth, compactDate, requestJson, toCount, windowDates,
} from './types.js';

export interface AmplitudeOptions extends WindowOptions {
  /** Amplitude API key (project settings → General). */
  apiKey: string;
  /** Amplitude secret key — the Dashboard REST API needs both. */
  secretKey: string;
  /** Dashboard API host. Defaults by region. */
  host?: string;
  region?: 'us' | 'eu';
  /** Max group-by values per query. Amplitude's ceiling is 1000. */
  limit?: number;
}

const US_HOST = 'https://amplitude.com';
const EU_HOST = 'https://analytics.eu.amplitude.com';
const EVENT_TYPE = 'atlas_screen';
export const GROUP_LIMIT = 1000;

/**
 * Amplitude bills each query a "cost" of days × conditions × type-cost and
 * rejects anything over 1000 in a 5-minute window. A funnel costs
 * days × steps × 2, so a 28-day 20-step funnel would be refused outright.
 * When the path is too expensive we say so and fall back to the estimate
 * rather than firing a request that 429s.
 */
export const MAX_QUERY_COST = 900;

/** Amplitude's label for "the property wasn't set on this event". */
const NONE_LABELS = new Set(['(none)', '(null)', 'undefined', '']);

interface SegmentationResponse {
  data?: {
    seriesLabels?: unknown[];
    seriesCollapsed?: Array<Array<{ value?: unknown }>>;
  };
}

interface FunnelResponse {
  data?: Array<{ cumulativeRaw?: unknown[] }>;
}

/** `{"event_type":"atlas_screen","filters":[…],"group_by":[…]}` */
function eventSpec(
  appId: string,
  groupBy: string[],
  screenKeys?: string[],
): string {
  const filters: Array<Record<string, unknown>> = [
    {
      subprop_type: 'event',
      subprop_key: 'atlas_app_id',
      subprop_op: 'is',
      subprop_value: [appId],
    },
  ];
  if (screenKeys) {
    filters.push({
      subprop_type: 'event',
      subprop_key: 'screen',
      subprop_op: 'is',
      subprop_value: screenKeys,
    });
  }
  const spec: Record<string, unknown> = { event_type: EVENT_TYPE, filters };
  if (groupBy.length > 0) {
    spec.group_by = groupBy.map(value => ({ type: 'event', value }));
  }
  return JSON.stringify(spec);
}

/**
 * One row per group: the label(s) and the range-deduplicated metric.
 * Amplitude returns `seriesLabels[i]` as a string for one group-by and an
 * array for two.
 */
function collapsedRows(payload: unknown): Array<{ labels: string[]; value: number }> {
  const data = (payload as SegmentationResponse).data;
  if (!data || !Array.isArray(data.seriesCollapsed)) return [];
  const labels = Array.isArray(data.seriesLabels) ? data.seriesLabels : [];
  const rows: Array<{ labels: string[]; value: number }> = [];
  for (let i = 0; i < data.seriesCollapsed.length; i++) {
    const label = labels[i];
    const parts = (Array.isArray(label) ? label : [label]).map(v => String(v ?? ''));
    rows.push({ labels: parts, value: toCount(data.seriesCollapsed[i]?.[0]?.value) });
  }
  return rows;
}

const clean = (label: string): string | null =>
  NONE_LABELS.has(label) ? null : label;

export function amplitudeSource(
  opts: AmplitudeOptions,
  log: (line: string) => void = () => {},
): CountsSource {
  const host = (opts.host ?? (opts.region === 'eu' ? EU_HOST : US_HOST)).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = Math.min(opts.limit ?? GROUP_LIMIT, GROUP_LIMIT);
  const { start, end } = windowDates(opts.days);
  const headers = {
    Authorization: basicAuth(opts.apiKey, opts.secretKey),
    Accept: 'application/json',
  };
  const hint = (status: number): string =>
    status === 401 || status === 403
      ? 'Check AMPLITUDE_API_KEY / AMPLITUDE_SECRET_KEY (the Dashboard API needs BOTH, and they are per-project).'
      : status === 429
        ? 'Amplitude rate limit — narrow --days or wait a few minutes.'
        : 'Or run offline with --counts <file>.';

  const get = (path: string, params: Array<[string, string]>): Promise<unknown> => {
    const qs = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return requestJson('Amplitude', `${host}${path}?${qs}`, { headers }, timeoutMs, hint);
  };

  const segmentation = (
    groupBy: string[],
    metric: 'uniques' | 'totals',
  ): Promise<unknown> =>
    get('/api/2/events/segmentation', [
      ['e', eventSpec(opts.appId, groupBy)],
      ['m', metric],
      ['start', compactDate(start)],
      ['end', compactDate(end)],
      ['i', '1'],
      ['limit', String(limit)],
    ]);

  return {
    id: 'amplitude',
    label: '● Amplitude · live',

    async fetchCounts(): Promise<Counts> {
      const [screenUniques, screenTotals, transitionRows, leaverRows] = await Promise.all([
        segmentation(['screen'], 'uniques'),
        segmentation(['screen'], 'totals'),
        segmentation(['prev_screen', 'screen'], 'uniques'),
        segmentation(['prev_screen'], 'uniques'),
      ]);

      const totalsByScreen = new Map<string, number>();
      for (const row of collapsedRows(screenTotals)) {
        const key = clean(row.labels[0]);
        if (key) totalsByScreen.set(key, row.value);
      }

      const screens: Record<string, ScreenCount> = {};
      let truncated = false;
      const uniqueRows = collapsedRows(screenUniques);
      if (uniqueRows.length >= limit) truncated = true;
      for (const row of uniqueRows) {
        const key = clean(row.labels[0]);
        if (!key) continue;
        screens[key] = { users: row.value, events: totalsByScreen.get(key) ?? row.value };
      }
      if (Object.keys(screens).length === 0) {
        throw new Error(
          `Amplitude returned 0 ${EVENT_TYPE} events for atlas_app_id=${opts.appId} ` +
          `in the last ${opts.days} days — check the app id, the project keys, and the time window.`,
        );
      }
      if (truncated) {
        log(
          `! Amplitude returned ${uniqueRows.length} screen groups — hit the limit of ${limit}, ` +
          'so the low-volume tail was truncated.',
        );
      }

      const transitions: TransitionCount[] = [];
      for (const row of collapsedRows(transitionRows)) {
        const src = clean(row.labels[0]);
        const dst = clean(row.labels[1]);
        if (!src || !dst) continue;
        transitions.push({ src, dst, users: row.value });
      }

      const leavers: Record<string, number> = {};
      for (const row of collapsedRows(leaverRows)) {
        const src = clean(row.labels[0]);
        if (src) leavers[src] = row.value;
      }

      return { source: 'amplitude', screens, transitions, leavers };
    },

    async fetchFunnel(stepKeys: string[][], windowSeconds: number): Promise<number[]> {
      const cost = opts.days * stepKeys.length * 2;
      if (cost > MAX_QUERY_COST) {
        throw new Error(
          `funnel would cost ${cost} against Amplitude's ~${MAX_QUERY_COST} per-query ceiling ` +
          `(${opts.days} days × ${stepKeys.length} steps × 2). Lower --days to ` +
          `${Math.max(1, Math.floor(MAX_QUERY_COST / (stepKeys.length * 2)))} or fewer.`,
        );
      }
      const params: Array<[string, string]> = stepKeys.map(
        keys => ['e', eventSpec(opts.appId, [], keys)] as [string, string],
      );
      params.push(
        ['start', compactDate(start)],
        ['end', compactDate(end)],
        ['mode', 'ordered'],
        ['n', 'active'],
        ['cs', String(windowSeconds)],
      );
      const payload = (await get('/api/2/funnels', params)) as FunnelResponse;
      const raw = payload.data?.[0]?.cumulativeRaw;
      if (!Array.isArray(raw) || raw.length !== stepKeys.length) {
        throw new Error(
          `Amplitude funnel returned ${Array.isArray(raw) ? raw.length : 0} steps, expected ${stepKeys.length}.`,
        );
      }
      const cohort: number[] = [];
      for (let i = 0; i < raw.length; i++) {
        const c = toCount(raw[i]);
        cohort.push(i === 0 ? c : Math.min(cohort[i - 1], c));
      }
      return cohort;
    },
  };
}
