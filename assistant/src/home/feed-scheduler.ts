/**
 * Home activity feed scheduler.
 *
 * Periodic tick loop that drives the feed producers — the assistant
 * roll-up loop and the platform-baseline Gmail digest generator. This
 * is the layer that turns the Phase-5 scaffolding into a live feed: the
 * producers exist as standalone functions, the writer knows how to
 * persist their output, and the HTTP route + SSE pipeline surface it
 * to the macOS client; this scheduler is what actually calls them.
 *
 * Design notes:
 *
 *   - Mirrors `schedule/scheduler.ts`: `setInterval` + coalescing flag
 *     so two ticks never run in parallel, `timer.unref()` so the timer
 *     never blocks daemon exit, stop() clears the interval on shutdown.
 *
 *   - Each producer tracks its own "last ran at" timestamp and decides
 *     whether to run on each tick. This keeps the tick cadence short
 *     (so cheap producers refresh often) while expensive producers
 *     (LLM roll-up) self-throttle independently.
 *
 *   - Fire-and-forget: every producer failure is logged and swallowed.
 *     A broken producer must never break the tick loop or the daemon.
 *
 *   - `writeAssistantFeedItem` / `generateGmailDigest` both invoke the
 *     feed writer directly, which publishes `home_feed_updated` on every
 *     successful write, so the macOS store auto-refreshes without this
 *     scheduler needing to touch the event hub.
 */

import { getLogger } from "../util/logger.js";
import type { FeedItem } from "./feed-types.js";
import {
  generateGmailDigest,
  type GmailCountSource,
} from "./platform-gmail-digest.js";
import { type RollupResult, runRollupProducer } from "./rollup-producer.js";

const log = getLogger("home-feed-scheduler");

/** Tick cadence — fast enough for a Gmail digest to feel fresh. */
const TICK_INTERVAL_MS = 5 * 60 * 1000;

/** Per-producer minimum gap between runs. */
const GMAIL_DIGEST_INTERVAL_MS = 5 * 60 * 1000;
const ROLLUP_INTERVAL_MS = 30 * 60 * 1000;

export interface FeedSchedulerHandle {
  /** Stops the interval. Safe to call multiple times. */
  stop(): void;
  /**
   * Run a single tick synchronously for tests. Returns a summary of
   * which producers ran during this tick.
   */
  runOnce(now?: Date): Promise<FeedTickSummary>;
}

export interface FeedTickSummary {
  gmailDigestRan: boolean;
  rollupRan: boolean;
}

export interface FeedSchedulerOptions {
  /**
   * Optional count source for the Gmail digest. Defaults to
   * {@link defaultGmailCountSource}, which reads the active OAuth
   * connection and issues one `messages.list?q=is:unread&maxResults=1`
   * call to read the `resultSizeEstimate` field (no body fetches).
   */
  gmailCountSource?: GmailCountSource;
  /**
   * When true (the default), the scheduler fires one tick synchronously
   * after startup so the feed is populated on the first app open after
   * daemon boot. Set to false in tests so the only ticks that run are
   * the ones the test drives via `runOnce()`.
   */
  runOnStart?: boolean;
  /**
   * Dependency seams for tests. Production callers pass `undefined` so
   * the scheduler uses the real producer implementations. Tests pass
   * spies to avoid `mock.module`, which leaks across files in Bun's
   * test runner.
   */
  gmailDigestRunner?: (
    now: Date,
    countSource: GmailCountSource,
  ) => Promise<FeedItem | null>;
  rollupRunner?: (now: Date) => Promise<RollupResult>;
}

/**
 * Start the home feed scheduler. Returns a handle whose `stop()` is
 * wired into the daemon shutdown sequence via `ShutdownDeps`.
 */
export function startFeedScheduler(
  options: FeedSchedulerOptions = {},
): FeedSchedulerHandle {
  let stopped = false;
  let tickRunning = false;
  let lastGmailDigestAt = 0;
  let lastRollupAt = 0;

  const gmailCountSource = options.gmailCountSource ?? defaultGmailCountSource;
  const gmailDigestRunner = options.gmailDigestRunner ?? generateGmailDigest;
  const rollupRunner =
    options.rollupRunner ?? ((now: Date) => runRollupProducer(now));

  const tick = async (now: Date = new Date()): Promise<FeedTickSummary> => {
    const summary: FeedTickSummary = {
      gmailDigestRan: false,
      rollupRan: false,
    };
    if (stopped || tickRunning) return summary;
    tickRunning = true;
    const nowMs = now.getTime();
    try {
      if (nowMs - lastGmailDigestAt >= GMAIL_DIGEST_INTERVAL_MS) {
        lastGmailDigestAt = nowMs;
        summary.gmailDigestRan = true;
        const startedAt = Date.now();
        try {
          const item = await gmailDigestRunner(now, gmailCountSource);
          log.info(
            { wroteItem: item !== null, durationMs: Date.now() - startedAt },
            "Gmail digest producer ran",
          );
        } catch (err) {
          log.warn(
            { err, durationMs: Date.now() - startedAt },
            "Gmail digest producer threw",
          );
        }
      }

      if (nowMs - lastRollupAt >= ROLLUP_INTERVAL_MS) {
        summary.rollupRan = true;
        const startedAt = Date.now();
        try {
          const result = await rollupRunner(now);
          log.info(
            {
              wroteCount: result.wroteCount,
              skippedReason: result.skippedReason,
              durationMs: Date.now() - startedAt,
            },
            "Rollup producer ran",
          );
          // Only advance the cooldown gate when the producer actually
          // had a chance to run the LLM. Two skip reasons short-circuit
          // before any provider call and should NOT burn the window:
          //   - `no_provider`: the provider registry wasn't ready yet
          //     (happens on the startup tick because the feed scheduler
          //     boots before the provider init pass in
          //     `daemon/lifecycle.ts`).
          //   - `no_actions`: there was nothing to roll up. A subsequent
          //     tick should retry as soon as new actions land, not wait
          //     the full window.
          // Every other outcome — success, empty items, malformed
          // output, provider error — is a real LLM attempt and does
          // advance the gate so a broken producer doesn't hammer us.
          if (
            result.skippedReason !== "no_provider" &&
            result.skippedReason !== "no_actions"
          ) {
            lastRollupAt = nowMs;
          }
        } catch (err) {
          lastRollupAt = nowMs;
          log.warn(
            { err, durationMs: Date.now() - startedAt },
            "Rollup producer threw",
          );
        }
      }
    } finally {
      tickRunning = false;
    }
    return summary;
  };

  const timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  timer.unref();
  if (options.runOnStart !== false) {
    // Fire once on startup so the feed is populated on the first app
    // open after daemon boot. Runs in the background — startup does
    // not await it.
    void tick();
  }

  log.info(
    {
      tickIntervalMs: TICK_INTERVAL_MS,
      gmailDigestIntervalMs: GMAIL_DIGEST_INTERVAL_MS,
      rollupIntervalMs: ROLLUP_INTERVAL_MS,
    },
    "Home feed scheduler started",
  );

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      log.info("Home feed scheduler stopped");
    },
    runOnce: tick,
  };
}

/**
 * Default Gmail count source — resolves the active `google` OAuth
 * connection via {@link resolveOAuthConnection}, issues one cheap
 * `messages.list` call with `q=is:unread&maxResults=1`, and returns
 * the `resultSizeEstimate` field. Returns 0 when no Gmail connection
 * exists or the call fails so the digest generator no-ops without
 * throwing.
 *
 * Deliberately does NOT pre-check `isProviderConnected("google")` —
 * that helper only reports local oauth-store rows, which are absent
 * in managed-OAuth mode even when `resolveOAuthConnection("google")`
 * would still resolve via the platform path. Letting the resolver
 * make the decision is the only way to cover both modes.
 */
async function defaultGmailCountSource(): Promise<number> {
  // Lazy import — the oauth resolver + gmail client drag in a fair
  // bit of transitive state, and we only want to pay that cost when a
  // tick actually runs (not at module load time).
  const [{ resolveOAuthConnection }, { listMessages }] = await Promise.all([
    import("../oauth/connection-resolver.js"),
    import("../messaging/providers/gmail/client.js"),
  ]);

  try {
    const connection = await resolveOAuthConnection("google");
    const response = await listMessages(connection, "is:unread", 1);
    const estimate = response.resultSizeEstimate;
    return typeof estimate === "number" && estimate >= 0 ? estimate : 0;
  } catch (err) {
    // Either no Gmail connection exists (managed or direct) or the
    // API call itself failed. Both paths degrade to zero so the
    // digest generator no-ops without writing a stale item.
    log.warn({ err }, "Gmail count source failed; treating as zero");
    return 0;
  }
}
