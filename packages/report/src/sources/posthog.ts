/* ============================================================
   sources/posthog.ts — the HogQL source, as a CountsSource.

   The query text and response parsing live in ../posthog.ts (the
   original module, unchanged); this is the thin adapter that
   makes PostHog one source among several.
   ============================================================ */

import { fetchCounts, fetchFunnel, type PostHogOptions } from '../posthog.js';
import type { Counts } from '../types.js';
import type { CountsSource } from './types.js';

export function posthogSource(opts: PostHogOptions): CountsSource {
  return {
    id: 'posthog',
    label: '● PostHog · live',
    fetchCounts(): Promise<Counts> {
      return fetchCounts(opts);
    },
    fetchFunnel(stepKeys: string[][], windowSeconds: number): Promise<number[]> {
      return fetchFunnel(opts, stepKeys, windowSeconds);
    },
  };
}
