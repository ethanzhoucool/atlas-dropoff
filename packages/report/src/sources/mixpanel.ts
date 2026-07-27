/* ============================================================
   mixpanel.ts — Mixpanel source, via the raw event export.

   Why export instead of the segmentation API: Mixpanel's
   /api/query/segmentation reports uniques PER TIME UNIT, and
   summing days double-counts everyone who came back. There is no
   range-collapsed unique count to ask for, so the honest move is
   to stream the raw events and count distinct users here.

   The upside: the same stream gives an exact sequential funnel
   (see sources/local.ts), matching what the PostHog source gets
   from windowFunnel.
   ============================================================ */

import type { Counts } from '../types.js';
import { EventAccumulator, parseEventLine } from './local.js';
import type { CountsSource, WindowOptions } from './types.js';
import { DEFAULT_TIMEOUT_MS, basicAuth, isoDate, windowDates } from './types.js';

export interface MixpanelOptions extends WindowOptions {
  /** Service-account username (Project Settings → Service Accounts). */
  username: string;
  /** Service-account secret. */
  secret: string;
  /** Numeric Mixpanel project id — required for service-account auth. */
  projectId: string;
  /** Export API host. Defaults by region. */
  host?: string;
  region?: 'us' | 'eu';
  /** Stop reading after this many events (safety valve). Default 2,000,000. */
  maxEvents?: number;
}

const US_HOST = 'https://data.mixpanel.com';
const EU_HOST = 'https://data-eu.mixpanel.com';
const EVENT_NAME = 'atlas_screen';
const DEFAULT_MAX_EVENTS = 2_000_000;

/**
 * Read a response body as newline-delimited JSON, one line at a time. Exports
 * of a busy app run to hundreds of MB; buffering the whole thing before
 * parsing would be the only part of this tool that can't handle real traffic.
 */
export async function* jsonlLines(res: Response): AsyncGenerator<string> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    // Non-streaming response (mock servers, older polyfills).
    const text = await res.text();
    for (const line of text.split('\n')) yield line;
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

export function mixpanelSource(
  opts: MixpanelOptions,
  log: (line: string) => void = () => {},
): CountsSource {
  const host = (opts.host ?? (opts.region === 'eu' ? EU_HOST : US_HOST)).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const { start, end } = windowDates(opts.days);

  const accumulator = new EventAccumulator();
  let loaded: Promise<void> | undefined;

  const load = async (): Promise<void> => {
    // Encoded by hand rather than with URLSearchParams: that spells a space
    // as "+", and the `where` expression below is full of them — a server
    // that reads "+" literally would reject the filter.
    const params: Array<[string, string]> = [
      ['project_id', opts.projectId],
      ['from_date', isoDate(start)],
      ['to_date', isoDate(end)],
      ['event', JSON.stringify([EVENT_NAME])],
      // Millisecond precision: several screens can land inside one second, and
      // tied timestamps make their order — and so the funnel — ambiguous.
      ['time_in_ms', 'true'],
      // Segmentation expression — keeps other apps in the same project out.
      ['where', `properties["atlas_app_id"] == ${JSON.stringify(opts.appId)}`],
    ];
    const url = `${host}/api/2.0/export?${params
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: basicAuth(opts.username, opts.secret),
          Accept: 'application/x-ndjson',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new Error(
          `Mixpanel export timed out after ${Math.round(timeoutMs / 1000)}s — ` +
          'raise --timeout, narrow --days, or run offline with --counts <file>.',
        );
      }
      throw new Error(
        `Could not reach Mixpanel at ${url} (${e.message}). ` +
        'Check --host / your network, or run offline with --counts <file>.',
      );
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 400);
      const hint =
        res.status === 401 || res.status === 403
          ? 'Check MIXPANEL_SERVICE_ACCOUNT / MIXPANEL_SERVICE_SECRET (the service account needs access to this project).'
          : res.status === 400
            ? 'Check --project / MIXPANEL_PROJECT_ID (service-account auth requires the numeric project id).'
            : res.status === 429
              ? 'Mixpanel export rate limit (60/hour) — wait, or run offline with --counts <file>.'
              : 'Or run offline with --counts <file>.';
      throw new Error(`Mixpanel export failed: ${res.status} ${res.statusText}\n${body}\n${hint}`);
    }

    let capped = false;
    for await (const line of jsonlLines(res)) {
      const event = parseEventLine(line, { appId: opts.appId, eventName: EVENT_NAME });
      if (!event) continue;
      accumulator.add(event);
      if (accumulator.eventCount >= maxEvents) {
        capped = true;
        break;
      }
    }
    if (capped) {
      log(
        `! stopped after ${maxEvents.toLocaleString('en-US')} events (--max-events) — ` +
        'the report covers only the earliest part of the window.',
      );
    }
    log(
      `· Mixpanel export: ${accumulator.eventCount.toLocaleString('en-US')} events, ` +
      `${accumulator.userCount.toLocaleString('en-US')} users`,
    );
    if (accumulator.eventCount === 0) {
      throw new Error(
        `Mixpanel returned 0 ${EVENT_NAME} events for atlas_app_id=${opts.appId} ` +
        `in the last ${opts.days} days — check the app id, the project id, and the time window.`,
      );
    }
  };

  /** The export is one request; both queries read the same materialized stream. */
  const ensure = (): Promise<void> => (loaded ??= load());

  return {
    id: 'mixpanel',
    label: '● Mixpanel · live',

    async fetchCounts(): Promise<Counts> {
      await ensure();
      return accumulator.toCounts('mixpanel');
    },

    async fetchFunnel(stepKeys: string[][], windowSeconds: number): Promise<number[]> {
      await ensure();
      return accumulator.funnel(stepKeys, windowSeconds);
    },
  };
}
