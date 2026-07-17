/**
 * The capture / batch / transport singleton.
 *
 * Transport is a plain `fetch` POST to PostHog's /batch/ endpoint — no native
 * modules, no posthog-react-native, safe in Expo Go. Nothing in here ever
 * throws into app code: delivery failures are swallowed (and surfaced via
 * console.warn when `debug` is on).
 */

import { AppState } from "react-native";
import type { NativeEventSubscription } from "react-native";
import { generateId, getOrCreateInstallId } from "./id";
import { createStorage } from "./storage";
import type { AtlasStorage } from "./storage";
import type {
  AtlasAnalyticsConfig,
  AtlasCapturedEvent,
  AtlasEventProperties,
  TrackScreenOptions,
} from "./types";

const SDK_NAME = "atlas-analytics-rn";
const SDK_VERSION = "0.1.0";
const SCREEN_EVENT = "atlas_screen";

const DEFAULT_HOST = "https://us.i.posthog.com";
const DEFAULT_FLUSH_AT = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const MIN_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
/** Hard cap so an offline session can't grow the queue unbounded. */
const MAX_QUEUE_SIZE = 500;

const IDENTIFIED_ID_KEY = "atlas_analytics.identified_id";

export class AtlasClient {
  private readonly config: Required<AtlasAnalyticsConfig>;
  private readonly storage: AtlasStorage;
  private readonly flushTimer: ReturnType<typeof setInterval>;
  private readonly appStateSubscription: NativeEventSubscription | undefined;

  private queue: AtlasCapturedEvent[] = [];
  private sessionId: string;
  private lastScreenKey: string | null = null;
  private flushing = false;
  /** The in-flight flush, so concurrent flush() callers can await it. */
  private flushPromise: Promise<void> = Promise.resolve();
  /**
   * Bumped on every identify()/reset(). Chained identity ops snapshot it at
   * call time and skip their distinctId/storage writes when a newer call has
   * superseded them, so a stale op can never clobber the current identity.
   */
  private identityEpoch = 0;

  /** Anonymous per-install id, loaded (or minted) from storage at init. */
  private installId: string | undefined;
  /** Current stamping id: identified user id, else the install id. */
  private distinctId: string | undefined;
  /**
   * Settles once the persisted ids are loaded. identify()/reset() chain their
   * storage work onto it so mutations apply in call order. Never rejects.
   */
  private identityReady: Promise<void>;

  constructor(config: AtlasAnalyticsConfig) {
    this.config = {
      apiKey: config.apiKey,
      atlasAppId: config.atlasAppId,
      host: (config.host ?? DEFAULT_HOST).replace(/\/+$/, ""),
      debug: config.debug ?? false,
      flushAt: Math.max(1, config.flushAt ?? DEFAULT_FLUSH_AT),
      flushInterval: Math.max(
        MIN_FLUSH_INTERVAL_MS,
        config.flushInterval ?? DEFAULT_FLUSH_INTERVAL_MS
      ),
      requestTimeout: Math.max(
        1,
        config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS
      ),
      normalizeScreen: config.normalizeScreen ?? ((screen: string) => screen),
    };

    if (!this.config.apiKey) {
      console.warn(
        "[atlas-analytics] apiKey is empty — events will be captured but not delivered."
      );
    }
    if (!this.config.atlasAppId) {
      console.warn(
        "[atlas-analytics] atlasAppId is empty — events won't join to your Atlas map."
      );
    }

    this.storage = createStorage();
    this.sessionId = generateId();
    this.identityReady = this.loadIdentity();

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushInterval);

    // Flush when the app is backgrounded so short sessions aren't lost.
    // Best effort: iOS/Android give a brief window for in-flight requests.
    // "inactive" is deliberately NOT a flush trigger — iOS fires it for
    // transient interruptions (app-switcher peek, Control Center) that would
    // cause redundant flushes.
    this.appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        void this.flush();
      }
    });
  }

  /**
   * Record a screen view. Consecutive duplicates are dropped, so it's safe to
   * wire this to both onReady and onStateChange, or to focus-style callbacks
   * that can re-fire for the same screen.
   */
  trackScreen(screen: string, options?: TrackScreenOptions): void {
    const resolved = options?.screenKeyOverride ?? screen;
    if (!resolved) {
      return;
    }
    // normalizeScreen is the config-wide escape hatch for collapsing dynamic
    // screen keys (e.g. `/users/123` → `/users/[id]`). It runs on the
    // resolved key — after screenKeyOverride, before dedupe — so it applies
    // uniformly to auto tracking, manual trackScreen() calls, and the React
    // Navigation helpers.
    let key: string;
    try {
      key = this.config.normalizeScreen(resolved);
    } catch (error) {
      key = resolved;
      this.warnDebug("normalizeScreen threw — using the raw key", error);
    }
    if (!key || key === this.lastScreenKey) {
      return;
    }

    const properties: AtlasEventProperties = {
      screen: key,
      prev_screen: this.lastScreenKey,
      $screen_name: key,
    };
    if (options?.title !== undefined) {
      properties.screen_title = options.title;
    }

    this.lastScreenKey = key;
    this.capture(SCREEN_EVENT, properties);
  }

  /** Capture an arbitrary custom event (still tagged with app/session/sdk). */
  track(event: string, properties?: AtlasEventProperties): void {
    if (!event) {
      return;
    }
    this.capture(event, properties ?? {});
  }

  /**
   * Attach a real user id. Sends a PostHog `$identify` event (with
   * `$anon_distinct_id` so the anonymous history merges into the user) and
   * persists the id so future launches keep it until `reset()`.
   */
  identify(userId: string, props?: AtlasEventProperties): void {
    if (!userId) {
      return;
    }
    // Same id with no props is a true no-op. Same id WITH props still sends a
    // $identify so the $set update reaches the (already identified) user.
    if (userId === this.distinctId && !props) {
      return;
    }
    // Freeze the transition at call time. The chained op below runs later, and
    // by then this.distinctId may have moved on (a rapid second identify(), a
    // reset()) — the $identify event must describe THIS call's from→to.
    const fromId = this.distinctId;
    const toId = userId;
    const epoch = ++this.identityEpoch;
    // Switch synchronously so events tracked right after identify() already
    // carry the user id. `fromId` may be undefined if the persisted id is
    // still loading — the chained op below falls back to the install id then.
    if (this.distinctId !== toId) {
      this.distinctId = toId;
    }

    this.identityReady = this.identityReady.then(async () => {
      const previous = fromId ?? this.installId;
      const properties: AtlasEventProperties = {};
      if (previous !== undefined && previous !== toId) {
        properties.$anon_distinct_id = previous;
      }
      if (props) {
        properties.$set = props;
      }
      if (properties.$anon_distinct_id !== undefined || props) {
        // Stamped with the frozen toId — never the mutable this.distinctId.
        this.capture("$identify", properties, toId);
      }
      // Persist only if no later identify()/reset() superseded this call.
      if (this.identityEpoch === epoch) {
        try {
          await this.storage.setItem(IDENTIFIED_ID_KEY, toId);
        } catch {
          // Memory-only storage — the identity just won't survive a restart.
        }
        this.logDebug(`identified as ${toId}`);
      }
    });
  }

  /**
   * Logout: drop the identified user id, go back to the anonymous install id,
   * and start a fresh session (so the next screen has `prev_screen: null`).
   */
  reset(): void {
    // Session + screen chain rotate synchronously so the very next
    // trackScreen() call is already attributed to the new session.
    this.sessionId = generateId();
    this.lastScreenKey = null;
    const epoch = ++this.identityEpoch;
    // Unconditional: may set undefined while installId is still loading —
    // that's correct, post-reset events must never carry the stale identified
    // id. The flush-time restamp (and the chained op below) fill in the
    // install id once it's available.
    this.distinctId = this.installId;
    this.identityReady = this.identityReady.then(async () => {
      if (this.identityEpoch !== epoch) {
        // A later identify() (or reset()) superseded this one — applying the
        // install id now would clobber the newer identity.
        return;
      }
      this.distinctId = this.installId; // covers a reset() while ids were loading
      try {
        await this.storage.removeItem(IDENTIFIED_ID_KEY);
      } catch {
        // Ignore — worst case the old id resurfaces next launch.
      }
      this.logDebug("reset — anonymous install id restored, new session started");
    });
  }

  /** Send everything queued right now. Resolves when the attempt finishes. */
  async flush(): Promise<void> {
    if (this.flushing) {
      // Piggyback on the in-flight flush so callers (and shutdown()) actually
      // wait for the attempt to finish instead of resolving immediately.
      return this.flushPromise;
    }
    this.flushing = true;
    this.flushPromise = this.doFlush();
    return this.flushPromise;
  }

  private async doFlush(): Promise<void> {
    try {
      // Await the identity chain BEFORE checking the queue: a just-called
      // identify()/reset() may still be about to enqueue its $identify.
      // identityReady never rejects, so this is safe.
      await this.identityReady;
      const batch = this.queue.splice(0, this.queue.length);
      if (batch.length === 0) {
        return;
      }
      // Stamp any events captured before the persisted id finished loading.
      for (const item of batch) {
        if (!item.distinct_id) {
          item.distinct_id = this.distinctId ?? "anonymous";
        }
      }

      let body: string;
      try {
        body = JSON.stringify({
          api_key: this.config.apiKey,
          historical_migration: false,
          batch,
        });
      } catch (error) {
        // Non-serializable custom properties. Drop rather than retry forever.
        this.warnDebug("could not serialize events — dropping batch", error);
        return;
      }

      let response: Response;
      // Abort a stalled request after requestTimeout — without this, a hung
      // connection would never settle, `flushing` would stay true forever,
      // and delivery would be dead for the rest of the process lifetime.
      const abort = new AbortController();
      const abortTimer = setTimeout(
        () => abort.abort(),
        this.config.requestTimeout
      );
      try {
        response = await fetch(`${this.config.host}/batch/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: abort.signal,
        });
      } catch (error) {
        // Includes the AbortError from the timeout above — treated like any
        // transient network failure: keep the events for the next flush.
        this.requeue(batch);
        this.warnDebug("network error while flushing — events requeued", error);
        return;
      } finally {
        clearTimeout(abortTimer);
      }

      if (response.ok) {
        this.logDebug(`flushed ${batch.length} event(s)`);
      } else if (response.status === 429 || response.status >= 500) {
        // Transient — keep the events for the next flush.
        this.requeue(batch);
        this.warnDebug(`HTTP ${response.status} from PostHog — events requeued`);
      } else {
        // 4xx (bad api key, malformed payload): retrying would loop forever.
        this.warnDebug(
          `HTTP ${response.status} from PostHog — dropping ${batch.length} event(s)`
        );
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Stop background work (interval + AppState listener) after a final flush.
   * Rarely needed in apps — the client is meant to live as long as the app —
   * but useful in tests and hot-reload environments.
   */
  async shutdown(): Promise<void> {
    clearInterval(this.flushTimer);
    this.appStateSubscription?.remove();
    // Drain: wait out any in-flight flush (events captured during it stay
    // queued), then flush once more so nothing is left behind.
    await this.flushPromise;
    await this.flush();
  }

  private capture(
    event: string,
    properties: AtlasEventProperties,
    distinctIdOverride?: string
  ): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.shift(); // Drop the oldest — recent behavior matters more.
    }
    this.queue.push({
      event,
      // An explicit override (identify()'s frozen target id) always wins;
      // otherwise stamped at flush time if identity hasn't loaded yet. The
      // flush-time restamp only fills EMPTY ids, so overrides survive it.
      distinct_id: distinctIdOverride ?? this.distinctId ?? "",
      timestamp: new Date().toISOString(),
      properties: {
        ...properties,
        // Contract fields last, so custom properties can never clobber them.
        atlas_app_id: this.config.atlasAppId,
        session_id: this.sessionId,
        sdk: SDK_NAME,
        sdk_version: SDK_VERSION,
      },
    });
    this.logDebug(`captured ${event}`, properties);

    if (this.queue.length >= this.config.flushAt) {
      void this.flush();
    }
  }

  private async loadIdentity(): Promise<void> {
    this.installId = await getOrCreateInstallId(this.storage);
    let identified: string | null = null;
    try {
      identified = await this.storage.getItem(IDENTIFIED_ID_KEY);
    } catch {
      // Treat as anonymous.
    }
    // Don't clobber an identify() that already ran while this was loading.
    if (this.distinctId === undefined) {
      this.distinctId = identified ?? this.installId;
    }
  }

  private requeue(batch: AtlasCapturedEvent[]): void {
    this.queue = batch.concat(this.queue);
    if (this.queue.length > MAX_QUEUE_SIZE) {
      this.queue = this.queue.slice(this.queue.length - MAX_QUEUE_SIZE);
    }
  }

  private logDebug(message: string, ...extra: unknown[]): void {
    if (this.config.debug) {
      console.log(`[atlas-analytics] ${message}`, ...extra);
    }
  }

  private warnDebug(message: string, ...extra: unknown[]): void {
    if (this.config.debug) {
      console.warn(`[atlas-analytics] ${message}`, ...extra);
    }
  }
}

let sharedClient: AtlasClient | undefined;
let warnedUninitialized = false;

/**
 * Initialize the shared client. Idempotent: the first call wins and later
 * calls return the existing client (so <AtlasProvider> is StrictMode-safe).
 */
export function initAtlasAnalytics(config: AtlasAnalyticsConfig): AtlasClient {
  if (sharedClient) {
    if (config.debug) {
      console.warn(
        "[atlas-analytics] initAtlasAnalytics called more than once — keeping the existing client."
      );
    }
    return sharedClient;
  }
  sharedClient = new AtlasClient(config);
  return sharedClient;
}

/** The shared client, or undefined (with a one-time warning) if not initialized. */
export function getClient(): AtlasClient | undefined {
  if (!sharedClient && !warnedUninitialized) {
    warnedUninitialized = true;
    console.warn(
      "[atlas-analytics] Not initialized — wrap your app in <AtlasProvider> or call initAtlasAnalytics() first."
    );
  }
  return sharedClient;
}
