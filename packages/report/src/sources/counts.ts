/* ============================================================
   sources/counts.ts — offline source: a precomputed counts file.

   No per-user data, so no sequential funnel: the caller falls
   back to the monotone min-cohort estimate.
   ============================================================ */

import { loadCountsFile } from '../posthog.js';
import type { Counts } from '../types.js';
import type { CountsSource } from './types.js';

export function countsFileSource(file: string): CountsSource {
  return {
    id: 'counts-file',
    label: '● Counts file · offline',
    async fetchCounts(): Promise<Counts> {
      return loadCountsFile(file);
    },
  };
}
