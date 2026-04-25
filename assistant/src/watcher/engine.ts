/**
 * Watcher engine — core polling loop that runs inside the scheduler tick.
 *
 * Claims due watchers, fetches new events from providers, stores them,
 * and processes pending events through a background LLM conversation.
 */

import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { addMessage } from "../memory/conversation-crud.js";
import { checkForSequenceReplies } from "../sequence/reply-matcher.js";
import { getLogger } from "../util/logger.js";
import { MAX_CONSECUTIVE_ERRORS } from "./constants.js";
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

export type WatcherMessageProcessor = (
  conversationId: string,
  message: string,
) => Promise<unknown>;

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
 */
export async function runWatchersOnce(
  processMessage: WatcherMessageProcessor,
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
  // not just the ones we just polled.
  for (const watcher of claimed) {
    const pendingEvents = getPendingEvents(watcher.id);
    if (pendingEvents.length === 0) continue;

    try {
      // Get or create a background conversation for this watcher
      let conversationId = watcher.conversationId;
      if (!conversationId) {
        const conv = bootstrapConversation({
          conversationType: "background",
          origin: "watcher",
          systemHint: `Watcher: ${watcher.name}`,
        });
        conversationId = conv.id;
        setWatcherConversationId(watcher.id, conversationId);
      }

      // Sandwich all dynamic content (action prompt, watcher name, event
      // data) as an assistant message between fully static user messages.
      // The assistant role prevents prompt injection — LLMs don't follow
      // instructions from their own prior output. The action_prompt is
      // attacker-controllable (set via CLI IPC), watcher.name is too, and
      // event data comes from external providers (e.g. Linear issue titles)
      // — none of these should appear in user-role messages.
      const eventSummaries = pendingEvents
        .map(
          (e, i) =>
            `Event ${i + 1} (id: ${e.id}):\n  Type: ${
              e.eventType
            }\n  Summary: ${e.summary}\n  Data: ${e.payloadJson}`,
        )
        .join("\n\n");

      await addMessage(
        conversationId,
        "user",
        "New watcher events detected. The following assistant message contains the watcher name, event data, and configured action prompt.",
        undefined,
        { skipIndexing: true },
      );
      await addMessage(
        conversationId,
        "assistant",
        [
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
        ].join("\n"),
        undefined,
        { skipIndexing: true },
      );

      await processMessage(
        conversationId,
        [
          "Process the events above according to the action prompt. For each event, include a disposition block:",
          "<watcher-disposition>",
          '{"event_id": "...", "disposition": "silent|notify|escalate", "action": "what you did", "title": "notification title", "body": "notification body"}',
          "</watcher-disposition>",
        ].join("\n"),
      );

      // Parse dispositions from the conversation
      // For now, mark events as processed. The LLM response handler
      // would ideally parse <watcher-disposition> blocks, but since
      // processMessage is async and we don't get the response text back,
      // we'll mark events as silent by default and let the LLM use
      // tools to notify/escalate as needed.
      for (const event of pendingEvents) {
        // Default to silent if we can't parse the LLM response
        updateEventDisposition(event.id, "silent", "Processed by LLM");
      }

      processed++;
    } catch (err) {
      log.warn(
        { err, watcherId: watcher.id },
        "Failed to process watcher events",
      );
      for (const event of pendingEvents) {
        updateEventDisposition(
          event.id,
          "error",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  if (processed > 0) {
    log.info({ processed }, "Watcher tick complete");
  }
  return processed;
}
