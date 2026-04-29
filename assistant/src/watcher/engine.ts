/**
 * Watcher engine — core polling loop that runs inside the scheduler tick.
 *
 * Claims due watchers, fetches new events from providers, and processes
 * pending events through a background LLM conversation via the shared
 * `runBackgroundJob` runner so failures surface as `activity.failed`
 * notifications (see `runtime/background-job-runner.ts`).
 */

import { runBackgroundJob } from "../runtime/background-job-runner.js";
import { checkForSequenceReplies } from "../sequence/reply-matcher.js";
import { getLogger } from "../util/logger.js";
import { MAX_CONSECUTIVE_ERRORS, WATCHER_JOB_TIMEOUT_MS } from "./constants.js";
import { getWatcherProvider } from "./provider-registry.js";
import {
  claimDueWatchers,
  completeWatcherPoll,
  disableWatcher,
  failWatcherPoll,
  getPendingEvents,
  insertWatcherEvent,
  resetStuckWatchers,
  setWatcherConversationId,
  skipWatcherPoll,
  updateEventDisposition,
} from "./watcher-store.js";

const log = getLogger("watcher-engine");

export type WatcherNotifier = (notification: {
  title: string;
  body: string;
}) => void;

export type WatcherEscalator = (params: {
  title: string;
  body: string;
}) => void;

export interface WatcherEngineHandle {
  runOnce(): Promise<number>;
  stop(): void;
}

/**
 * Initialize the watcher engine. Call once at daemon startup.
 * Resets any watchers stuck in 'polling' state from a prior crash.
 */
export function initWatcherEngine(): void {
  const reset = resetStuckWatchers();
  if (reset > 0) {
    log.info({ count: reset }, "Reset stuck watchers to idle on startup");
  }
}

/**
 * Run one watcher tick: claim due watchers, fetch events, process them.
 * Called from the scheduler's runScheduleOnce().
 *
 * Each watcher with pending events is processed via `runBackgroundJob`,
 * which bootstraps a fresh background conversation per tick, applies a
 * timeout, and emits an `activity.failed` notification on any failure.
 */
export async function runWatchersOnce(
  notify: WatcherNotifier,
  _escalate: WatcherEscalator,
): Promise<number> {
  const now = Date.now();
  let processed = 0;

  // ── Phase 1: Poll providers for new events ──────────────────────
  const claimed = claimDueWatchers(now);
  for (const watcher of claimed) {
    const provider = getWatcherProvider(watcher.providerId);
    if (!provider) {
      failWatcherPoll(watcher.id, `Unknown provider: ${watcher.providerId}`);
      continue;
    }

    // Pre-poll credential gate: skip if token is irrecoverably broken.
    // Prevents wasting API calls and burning through circuit breaker
    // attempts on credentials that need manual reauthorization.
    try {
      const { checkCredentialForProvider } =
        await import("../credential-health/credential-health-service.js");
      const health = await checkCredentialForProvider(
        watcher.credentialService,
      );
      if (
        health &&
        (health.status === "revoked" ||
          health.status === "missing_token" ||
          (health.status === "expired" && !health.canAutoRecover))
      ) {
        skipWatcherPoll(watcher.id, `Credential unhealthy: ${health.details}`);
        continue;
      }
    } catch {
      // Non-fatal: proceed with normal poll if health check fails
    }

    try {
      const config = watcher.configJson ? JSON.parse(watcher.configJson) : {};

      // Initialize watermark on first poll
      let watermark = watcher.watermark;
      if (!watermark) {
        watermark = await provider.getInitialWatermark(
          watcher.credentialService,
        );
        log.info({ watcherId: watcher.id, watermark }, "Initialized watermark");
      }

      const result = await provider.fetchNew(
        watcher.credentialService,
        watermark,
        config,
        watcher.id,
      );

      // Store new events with dedup
      let newEvents = 0;
      const newPayloads: Array<Record<string, unknown>> = [];
      for (const item of result.items) {
        const inserted = insertWatcherEvent({
          watcherId: watcher.id,
          externalId: item.externalId,
          eventType: item.eventType,
          summary: item.summary,
          payloadJson: JSON.stringify(item.payload),
        });
        if (inserted) {
          newEvents++;
          newPayloads.push(item.payload);
        }
      }

      if (newEvents > 0) {
        log.info(
          { watcherId: watcher.id, name: watcher.name, newEvents },
          "Detected new events",
        );
      }

      // Check new events for replies to active sequence enrollments
      if (newPayloads.length > 0) {
        try {
          const replyMatches = checkForSequenceReplies(newPayloads);
          for (const match of replyMatches) {
            notify({
              title: `Sequence reply: ${match.sequenceName}`,
              body: `${match.contactEmail} replied — enrollment auto-exited.`,
            });
          }
        } catch (replyErr) {
          log.warn(
            { err: replyErr, watcherId: watcher.id },
            "Reply matcher failed",
          );
        }
      }

      completeWatcherPoll(watcher.id, {
        watermark: result.watermark,
        conversationId: watcher.conversationId ?? undefined,
      });
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err, watcherId: watcher.id, name: watcher.name },
        "Watcher poll failed",
      );
      failWatcherPoll(watcher.id, message);

      // Circuit breaker: disable after too many consecutive errors
      if (watcher.consecutiveErrors + 1 >= MAX_CONSECUTIVE_ERRORS) {
        const reason = `Disabled after ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Last: ${message}`;
        disableWatcher(watcher.id, reason);
        // Do NOT call provider.cleanup() here — auto-disable is reversible.
        // If the watcher is re-enabled later, it must diff against the same
        // baseline to avoid missing events that occurred while disabled.
        // Cleanup is only correct on true deletion (see watcher delete IPC route).
        log.warn(
          { watcherId: watcher.id, name: watcher.name },
          "Watcher disabled by circuit breaker",
        );
        notify({
          title: `Watcher disabled: ${watcher.name}`,
          body: reason,
        });
      }
    }
  }

  // ── Phase 2: Process pending events through LLM ─────────────────
  // Process events for all watchers that have pending events,
  // not just the ones we just polled. Each watcher gets a fresh
  // background conversation per tick via `runBackgroundJob`, which
  // applies a timeout and surfaces failures as `activity.failed`
  // notifications on the home feed.
  for (const watcher of claimed) {
    const pendingEvents = getPendingEvents(watcher.id);
    if (pendingEvents.length === 0) continue;

    const eventSummaries = pendingEvents
      .map(
        (e, i) =>
          `Event ${i + 1} (id: ${e.id}):\n  Type: ${
            e.eventType
          }\n  Summary: ${e.summary}\n  Data: ${e.payloadJson}`,
      )
      .join("\n\n");

    const prompt = [
      `Watcher: ${watcher.name}`,
      "",
      `${pendingEvents.length} event(s):`,
      "",
      eventSummaries,
      "",
      "---",
      "",
      "Action prompt:",
      watcher.actionPrompt,
      "",
      "---",
      "",
      "Process the events above according to the action prompt. For each event, include a disposition block:",
      "<watcher-disposition>",
      '{"event_id": "...", "disposition": "silent|notify|escalate", "action": "what you did", "title": "notification title", "body": "notification body"}',
      "</watcher-disposition>",
    ].join("\n");

    const result = await runBackgroundJob({
      jobName: `watcher:${watcher.id}`,
      source: "watcher",
      prompt,
      trustContext: { sourceChannel: "vellum", trustClass: "guardian" },
      callSite: "mainAgent",
      timeoutMs: WATCHER_JOB_TIMEOUT_MS,
      origin: "watcher",
    });

    // Persist the per-tick conversation id so downstream surfaces (UI,
    // store reads) can link back to the most recent watcher run.
    setWatcherConversationId(watcher.id, result.conversationId);

    if (result.ok) {
      // Mark events as silent by default. The LLM is expected to use
      // notify/escalate tools for events it deems worth surfacing — we
      // do not parse <watcher-disposition> blocks back out here.
      for (const event of pendingEvents) {
        updateEventDisposition(event.id, "silent", "Processed by LLM");
      }
      processed++;
    } else {
      log.warn(
        {
          err: result.error?.message,
          errorKind: result.errorKind,
          watcherId: watcher.id,
        },
        "Failed to process watcher events",
      );
      for (const event of pendingEvents) {
        updateEventDisposition(
          event.id,
          "error",
          result.error?.message ?? "Unknown error",
        );
      }
    }
  }

  if (processed > 0) {
    log.info({ processed }, "Watcher tick complete");
  }
  return processed;
}
