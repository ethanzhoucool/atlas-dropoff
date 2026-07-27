/* ============================================================
   events.ts — offline source: a JSONL file of raw events.

   Every vendor can export events, and this is the lowest common
   denominator: one JSON object per line. Unlike --counts (which
   carries only pre-aggregated totals), a raw event file supports
   the exact sequential funnel, because the per-user chronology
   is still in it.
   ============================================================ */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { Counts } from '../types.js';
import { EventAccumulator, parseEventLine } from './local.js';
import type { CountsSource } from './types.js';

export interface EventsFileOptions {
  file: string;
  /** Drop rows whose `atlas_app_id` is a different app. */
  appId?: string;
  /** Event name to keep. Default `atlas_screen`. */
  eventName?: string;
  /** Stop reading after this many events. */
  maxEvents?: number;
  /** Optional label for the report header. */
  dateRange?: string;
}

export function eventsFileSource(
  opts: EventsFileOptions,
  log: (line: string) => void = () => {},
): CountsSource {
  const accumulator = new EventAccumulator();
  let loaded: Promise<void> | undefined;

  const load = async (): Promise<void> => {
    if (!fs.existsSync(opts.file)) {
      throw new Error(`Could not read events file "${opts.file}": no such file.`);
    }
    const stream = readline.createInterface({
      input: fs.createReadStream(opts.file, 'utf8'),
      crlfDelay: Infinity,
    });
    let skipped = 0;
    try {
      for await (const line of stream) {
        if (!line.trim()) continue;
        const event = parseEventLine(line, {
          appId: opts.appId,
          eventName: opts.eventName,
        });
        if (!event) {
          skipped++;
          continue;
        }
        accumulator.add(event);
        if (opts.maxEvents && accumulator.eventCount >= opts.maxEvents) break;
      }
    } finally {
      stream.close();
    }
    if (accumulator.eventCount === 0) {
      throw new Error(
        `No usable events in "${opts.file}" (${skipped} line(s) skipped). Each line must be ` +
        'a JSON object with a `screen` and a user id — see packages/report/events.example.jsonl.',
      );
    }
    log(
      `· events file: ${accumulator.eventCount.toLocaleString('en-US')} events, ` +
      `${accumulator.userCount.toLocaleString('en-US')} users` +
      (skipped > 0 ? ` (${skipped.toLocaleString('en-US')} line(s) skipped)` : ''),
    );
  };

  const ensure = (): Promise<void> => (loaded ??= load());

  return {
    id: 'events-file',
    label: '● Raw events · offline file',

    async fetchCounts(): Promise<Counts> {
      await ensure();
      return accumulator.toCounts('events-file', opts.dateRange);
    },

    async fetchFunnel(stepKeys: string[][], windowSeconds: number): Promise<number[]> {
      await ensure();
      return accumulator.funnel(stepKeys, windowSeconds);
    },
  };
}
