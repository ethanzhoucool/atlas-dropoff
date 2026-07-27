/* ============================================================
   sources/index.ts — pick the analytics source.

   Explicit --source wins. Otherwise the offline flags decide, and
   failing that we look at which vendor's credentials are actually
   in the environment, so a single-vendor setup needs no flag.
   ============================================================ */

import type { SourceId } from '../types.js';
import { amplitudeSource } from './amplitude.js';
import { countsFileSource } from './counts.js';
import { eventsFileSource } from './events.js';
import { mixpanelSource } from './mixpanel.js';
import { posthogSource } from './posthog.js';
import type { CountsSource } from './types.js';
import { DEFAULT_TIMEOUT_MS } from './types.js';

export { amplitudeSource } from './amplitude.js';
export { countsFileSource } from './counts.js';
export { eventsFileSource } from './events.js';
export { mixpanelSource } from './mixpanel.js';
export { posthogSource } from './posthog.js';
export type { CountsSource } from './types.js';

/** Source ids accepted by `--source`. */
export const SOURCE_NAMES = ['posthog', 'amplitude', 'mixpanel', 'counts', 'events'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export interface SourceSelection {
  source?: string;
  counts?: string;
  events?: string;
  project?: string;
  host?: string;
  region?: 'us' | 'eu';
  days: number;
  timeoutMs?: number;
  maxEvents?: number;
  /** Canonical Atlas app id (matched against `atlas_app_id`). */
  appId: string;
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** Credentials present in the environment, per vendor. */
function available(env: NodeJS.ProcessEnv): Record<string, boolean> {
  return {
    posthog: Boolean(env.POSTHOG_PERSONAL_API_KEY),
    amplitude: Boolean(env.AMPLITUDE_API_KEY && env.AMPLITUDE_SECRET_KEY),
    mixpanel: Boolean(env.MIXPANEL_SERVICE_ACCOUNT && env.MIXPANEL_SERVICE_SECRET),
  };
}

/**
 * Which source to use, without touching the network. Returns the resolved
 * name plus how it was chosen, so the CLI can say so out loud.
 */
export function chooseSourceName(sel: SourceSelection): {
  name: SourceName;
  why: 'explicit' | 'flag' | 'env' | 'default';
} {
  if (sel.source) {
    const name = sel.source as SourceName;
    if (!SOURCE_NAMES.includes(name)) {
      throw new Error(
        `Unknown --source "${sel.source}". Expected one of: ${SOURCE_NAMES.join(', ')}.`,
      );
    }
    return { name, why: 'explicit' };
  }
  if (sel.counts) return { name: 'counts', why: 'flag' };
  if (sel.events) return { name: 'events', why: 'flag' };

  const have = available(sel.env);
  const live = (['posthog', 'amplitude', 'mixpanel'] as const).filter(v => have[v]);
  // Exactly one vendor configured → use it, no flag needed. Several (or none)
  // → PostHog stays the default and reports its own missing-credential error.
  if (live.length === 1) return { name: live[0], why: 'env' };
  return { name: 'posthog', why: 'default' };
}

/** `--source` name → the `Counts.source` id stamped into the report. */
export function sourceIdOf(name: SourceName): SourceId {
  return name === 'counts' ? 'counts-file' : name === 'events' ? 'events-file' : name;
}

/** Build the chosen source, validating that vendor's required inputs. */
export function createSource(sel: SourceSelection): CountsSource {
  const { name } = chooseSourceName(sel);
  const env = sel.env;
  const log = sel.log ?? ((): void => {});
  const timeoutMs = sel.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const region = sel.region ?? 'us';
  const need = (value: string | undefined, message: string): string => {
    if (!value) throw new Error(message);
    return value;
  };

  switch (name) {
    case 'counts':
      return countsFileSource(
        need(sel.counts, '--counts <file> is required for --source counts.'),
      );

    case 'events':
      return eventsFileSource(
        {
          file: need(sel.events, '--events <file> is required for --source events.'),
          appId: sel.appId,
          maxEvents: sel.maxEvents,
        },
        log,
      );

    case 'amplitude':
      return amplitudeSource(
        {
          apiKey: need(
            env.AMPLITUDE_API_KEY,
            'AMPLITUDE_API_KEY is not set. Export your Amplitude project API key ' +
            '(Settings → Projects → General), or run offline with --counts <file>.',
          ),
          secretKey: need(
            env.AMPLITUDE_SECRET_KEY,
            'AMPLITUDE_SECRET_KEY is not set. The Dashboard REST API needs the secret ' +
            'key as well as the API key (Settings → Projects → General).',
          ),
          appId: sel.appId,
          days: sel.days,
          timeoutMs,
          host: sel.host ?? env.AMPLITUDE_HOST,
          region,
        },
        log,
      );

    case 'mixpanel':
      return mixpanelSource(
        {
          username: need(
            env.MIXPANEL_SERVICE_ACCOUNT,
            'MIXPANEL_SERVICE_ACCOUNT is not set. Create a service account ' +
            '(Project Settings → Service Accounts) and export its username.',
          ),
          secret: need(
            env.MIXPANEL_SERVICE_SECRET,
            'MIXPANEL_SERVICE_SECRET is not set — export the service account secret.',
          ),
          projectId: need(
            sel.project ?? env.MIXPANEL_PROJECT_ID,
            'No Mixpanel project id — pass --project or set MIXPANEL_PROJECT_ID ' +
            '(service-account auth requires it).',
          ),
          appId: sel.appId,
          days: sel.days,
          timeoutMs,
          maxEvents: sel.maxEvents,
          host: sel.host ?? env.MIXPANEL_HOST,
          region,
        },
        log,
      );

    case 'posthog':
    default:
      return posthogSource({
        apiKey: need(
          env.POSTHOG_PERSONAL_API_KEY,
          'POSTHOG_PERSONAL_API_KEY is not set. Export a PostHog personal API key ' +
          '(query:read scope), or point --source at another vendor, or run offline ' +
          'with --counts <file> — see counts.example.json.',
        ),
        projectId: need(
          sel.project ?? env.POSTHOG_PROJECT_ID,
          'No PostHog project id — pass --project or set POSTHOG_PROJECT_ID.',
        ),
        host: sel.host ?? env.POSTHOG_HOST ?? 'https://us.posthog.com',
        appId: sel.appId,
        days: sel.days,
        timeoutMs,
      });
  }
}
