/**
 * `schedule.result` producer: the notification a scheduled run owes the user
 * when it produced output and never spoke up on its own.
 *
 * Every other conversation kind already has a producer that answers for it
 * (see the kind switch in `assistant-reply-producer.ts`). Scheduled runs were
 * the exception: their "producer" was the model remembering to call
 * `assistant notifications send`, decided per run against free-form prompt
 * text and the notifications skill's "only when something notable happened"
 * guidance. A daily briefing could therefore run, spend money, write a reply
 * into a conversation nobody has open, and leave no trace the user ever sees.
 *
 * This closes that hole from the other end. It does not re-judge whether the
 * output was notable — that judgment is the bug. It asks two mechanical
 * questions: did this run say anything, and has the user been told? A run that
 * notified itself is left alone, so a well-authored schedule sees no change
 * and no duplicate.
 *
 * Deliberately scoped to execute-mode schedule runs. Heartbeats, watchers, and
 * background jobs stay strict — their firing is the assistant's idea, so
 * silence is the correct default. A schedule's firing is the user's idea, on a
 * cadence they chose, which is what earns its output a notification.
 *
 * Best-effort throughout, like every producer here: a notification failure
 * must never turn a schedule run that succeeded into one recorded as failed.
 */

import type pino from "pino";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { emitNotificationSignal } from "./emit-signal.js";
import { hasNotifiedSourceContextSince } from "./events-store.js";
import { sanitizeNotificationTitle } from "./notification-utils.js";
import {
  collectRunRows,
  deliveredThroughMessagingTool,
  resolveLatestRunRow,
  resolveRunOutput,
} from "./result-output.js";

/** Kill switch for this producer, on by default. */
const SCHEDULE_RESULT_NOTIFY_FLAG = "schedule-result-notify" as const;

export interface ScheduleResultNotificationParams {
  /** `cron_jobs.id` of the schedule that fired. */
  scheduleId: string;
  /** The schedule's user-authored name; becomes the notification title. */
  scheduleName: string;
  /** Conversation the run executed in. */
  conversationId: string;
  /** `cron_runs.id` for this firing — scopes the dedupe key to one run. */
  runId: string;
  /**
   * When the run started, in epoch ms. The lower bound on the "did this run
   * already notify?" probe, and the reason a reused conversation's earlier
   * runs cannot silence this one.
   */
  runStartedAt: number;
  rlog: pino.Logger;
}

/**
 * Emit the fallback notification for a schedule run that finished without
 * notifying. No-ops when the flag is off, when the run already notified, or
 * when the run produced no user-facing text.
 */
export async function emitScheduleResultNotification(
  params: ScheduleResultNotificationParams,
): Promise<void> {
  const {
    scheduleId,
    scheduleName,
    conversationId,
    runId,
    runStartedAt,
    rlog,
  } = params;
  try {
    if (!isAssistantFeatureFlagEnabled(SCHEDULE_RESULT_NOTIFY_FLAG)) {
      return;
    }
    // A bootstrap failure hands back a sentinel rather than a real id; there
    // is no conversation to read and nothing to say about it.
    if (!conversationId || conversationId.startsWith("bootstrap-error:")) {
      return;
    }

    // The run spoke for itself — an explicit `assistant notifications send`,
    // or any other signal the turn emitted against this conversation, that
    // reached a verdict or a channel. Leaving it alone is what keeps a
    // well-authored schedule from notifying twice.
    if (hasNotifiedSourceContextSince(conversationId, runStartedAt)) {
      return;
    }

    const latestRow = resolveLatestRunRow(conversationId, runStartedAt);
    if (!latestRow) {
      return;
    }

    // The run delivered around the pipeline through the messaging tool, and
    // the call succeeded. The user has the result; a notification reading
    // "posted it" on top would be the duplicate.
    const runRows = collectRunRows(latestRow, conversationId, runStartedAt);
    if (deliveredThroughMessagingTool(conversationId, runRows)) {
      return;
    }

    const body = resolveRunOutput(runRows);
    if (!body) {
      return;
    }

    // Schedule names are user-authored and unbounded, so the title gets the
    // same clamp as any other string headed for a lock screen.
    const requestedTitle = sanitizeNotificationTitle(
      scheduleName.replace(/\s+/g, " ").trim(),
    );

    await emitNotificationSignal({
      sourceEventName: "schedule.result",
      sourceChannel: "scheduler",
      // The run's conversation: the deep-link target, and what tells
      // `resolveHomeFeedMirror` this is a background conversation worth
      // mirroring into the home feed.
      sourceContextId: conversationId,
      attentionHints: {
        requiresAction: false,
        // Medium, not low: low routes to the notification center alone and
        // posts silently, which is the invisibility this producer exists to
        // fix. Not high either — that force-adds an in-app banner on every
        // client for what is a digest, not an alarm.
        urgency: "medium",
        // Marks the signal as background-originated, which is what earns the
        // home-feed mirror independently of the conversation-type check.
        isAsyncBackground: true,
        // Nobody is watching a scheduled run's conversation; that is the
        // premise of this whole producer.
        visibleInSourceNow: false,
      },
      contextPayload: {
        requestedTitle,
        requestedMessage: body,
        scheduleName,
        scheduleId,
      },
      // Keyed on the run, not the schedule: the pipeline's dedupe window is a
      // flat hour, so a schedule firing more often than hourly would have its
      // later runs silently dropped under a schedule-scoped key.
      dedupeKey: `schedule.result:${scheduleId}:${runId}`,
    });

    rlog.info(
      { scheduleId, runId, conversationId },
      "Emitted fallback notification for a schedule run that produced output without notifying",
    );
  } catch (err) {
    rlog.warn(
      { err, scheduleId, runId, conversationId },
      "Failed to emit schedule result notification (non-fatal)",
    );
  }
}
