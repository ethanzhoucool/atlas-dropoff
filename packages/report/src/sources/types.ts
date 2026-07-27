/* ============================================================
   sources/types.ts — the analytics-source contract.

   A source answers two questions about one app over one time
   window: "how many distinct users saw each screen (and moved
   between them)", and optionally "how many completed this exact
   ordered path". Everything downstream — mapping, funnel math,
   rendering — is source-agnostic.
   ============================================================ */

import type { Counts, SourceId } from '../types.js';

export interface CountsSource {
  readonly id: SourceId;
  /** Shown on the report's source pill, e.g. "Amplitude · live". */
  readonly label: string;
  /** Per-screen / per-transition / leaver counts for the window. */
  fetchCounts(): Promise<Counts>;
  /**
   * Distinct users completing the first k of these ordered steps, for
   * k = 1..N. `stepKeys[i]` are the screen keys mapped to the i-th Atlas node.
   * Omitted by sources that can't answer it (the caller falls back to the
   * monotone min-cohort estimate).
   */
  fetchFunnel?(stepKeys: string[][], windowSeconds: number): Promise<number[]>;
}

export interface WindowOptions {
  /** Canonical Atlas app id — matched against the `atlas_app_id` property. */
  appId: string;
  days: number;
  /** Per-request HTTP timeout in milliseconds. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 60_000;

/** UTC calendar day, `days`-1 back from today, as [start, end] Date objects. */
export function windowDates(days: number): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { start, end };
}

/** `20260727` — Amplitude's date format. */
export function compactDate(d: Date): string {
  return isoDate(d).replace(/-/g, '');
}

/** `2026-07-27` — Mixpanel's date format. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** HTTP Basic credential, for the vendors that use one. */
export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/**
 * Shared fetch wrapper: turns network failures and non-2xx responses into
 * one-line, actionable errors instead of stack traces.
 */
export async function requestJson(
  vendor: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  hintFor: (status: number) => string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(
        `${vendor} query timed out after ${Math.round(timeoutMs / 1000)}s — ` +
        'narrow --days, raise --timeout, or run offline with --counts <file>.',
      );
    }
    throw new Error(
      `Could not reach ${vendor} at ${url} (${e.message}). ` +
      'Check --host / your network, or run offline with --counts <file>.',
    );
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 400);
    throw new Error(
      `${vendor} query failed: ${res.status} ${res.statusText}\n${body}\n${hintFor(res.status)}`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`Unexpected non-JSON response from ${vendor} at ${url}.`);
  }
}

/** Coerce a vendor's count to a non-negative integer. */
export function toCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
