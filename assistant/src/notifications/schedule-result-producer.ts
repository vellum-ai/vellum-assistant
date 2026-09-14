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
import { getAttentionStateByConversationIds } from "../persistence/conversation-attention-store.js";
import {
  getAssistantMessageIdsInTurn,
  getMessageById,
  type MessageRow,
} from "../persistence/conversation-crud.js";
import { stringifyMessageContent } from "../persistence/message-content.js";
import {
  isPrivateAssistantText,
  projectPersistedAssistantContent,
} from "../persistence/user-facing-content.js";
import type { ContentBlock } from "../providers/types.js";
import { emitNotificationSignal } from "./emit-signal.js";
import { hasNotifiedSourceContextSince } from "./events-store.js";
import {
  decodeLiteralLineBreaks,
  sanitizeNotificationTitle,
  stripMarkdownForPreview,
  truncate,
} from "./notification-utils.js";

/** Kill switch for this producer, on by default. */
const SCHEDULE_RESULT_NOTIFY_FLAG = "schedule-result-notify" as const;

/**
 * Body cap. Far above `MESSAGE_PREVIEW_MAX_LENGTH` (200) on purpose: this body
 * is the deliverable, not a preview of one, and the home feed's detail panel
 * renders it as markdown. A lock-screen banner truncates on its own, so the
 * cap exists only to keep a runaway reply out of the payload.
 */
const MAX_RESULT_BODY_CHARS = 2000;

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
 * Whether a tool call in the run's turn delivered the result somewhere the
 * user will see it, outside the notification pipeline.
 *
 * The schedule skill prescribes two such routes for rich content — the
 * messaging tool for email, and the Slack Web API's `chat.postMessage` through
 * bash — and neither writes a `notification_events` row, so the pipeline probe
 * cannot see them. Without this check a well-authored Slack digest would post
 * its summary and then get a second notification whose body is "Posted the
 * digest to #general." This is a recognized-routes list, not a general "did
 * the run do anything?" heuristic: a route that is not here gets the fallback,
 * which is the safe failure.
 */
function isDirectDelivery(block: ContentBlock): boolean {
  if (block.type !== "tool_use") {
    return false;
  }
  if (block.name === "messaging_send") {
    return true;
  }
  if (block.name === "bash") {
    const command = (block.input as { command?: unknown } | undefined)?.command;
    return typeof command === "string" && command.includes("chat.postMessage");
  }
  return false;
}

/**
 * The assistant rows this run wrote, in order, ending on `latestRow`.
 *
 * A run is one agent turn: `getAssistantMessageIdsInTurn` walks the tool-call
 * loop back to the user message that opened it. Rows from before the run
 * started are dropped defensively — a reused conversation's earlier turns must
 * never be mistaken for this one.
 */
function collectRunRows(
  latestRow: MessageRow,
  conversationId: string,
  runStartedAt: number,
): MessageRow[] {
  const rows: MessageRow[] = [];
  for (const id of getAssistantMessageIdsInTurn(latestRow.id)) {
    const row =
      id === latestRow.id ? latestRow : getMessageById(id, conversationId);
    if (row && row.createdAt >= runStartedAt) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Whether the run left the user anything worth reading, and what.
 *
 * Substance is judged mechanically: markdown is flattened and whitespace
 * collapsed, and whatever survives is the answer. A run that ended on tool
 * calls with no closing prose flattens to nothing and stays silent — the
 * "nothing to say" case. Anything else counts, including a briefing whose
 * honest finding is that nothing changed; the user asked for that cadence, and
 * "no new mail today" is a result, not noise.
 *
 * Every row is read through the user-facing projection, so a scheduled run
 * that routed its reply through `send_user_message` quotes the message it
 * delivered rather than the private scratchpad behind it. A scheduled run
 * resolves the `mainAgent` call site, so it is gated like any app turn.
 *
 * The scan walks back only across rows marked private, because that is the
 * shape a gated run leaves: it ends on wrap-up notes that project to nothing,
 * with the delivered message on the earlier row carrying the call. An ordinary
 * run is read exactly as before: its last row, and silence if that row has no
 * prose.
 *
 * The returned body keeps its original markdown — only the emptiness test runs
 * on the flattened form, because the detail panel renders the real thing.
 */
function resolveRunOutput(runRows: readonly MessageRow[]): string | undefined {
  for (let i = runRows.length - 1; i >= 0; i--) {
    const row = runRows[i];
    const text = stringifyMessageContent(
      projectPersistedAssistantContent(row.content, row.metadata),
    );
    const flattened = stripMarkdownForPreview(text).replace(/\s+/g, " ").trim();
    if (flattened) {
      return truncate(
        decodeLiteralLineBreaks(text.trim()),
        MAX_RESULT_BODY_CHARS,
      );
    }
    if (!isPrivateAssistantText(row.metadata)) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The run's final assistant row, or nothing if the run wrote none.
 *
 * `latestAssistantMessageId` is per conversation, not per run, so a reused
 * conversation whose current run wrote no reply would otherwise hand back the
 * previous run's — and the fallback would re-send yesterday's briefing.
 */
function resolveLatestRunRow(
  conversationId: string,
  runStartedAt: number,
): MessageRow | undefined {
  const attention = getAttentionStateByConversationIds([conversationId]).get(
    conversationId,
  );
  const assistantMessageId = attention?.latestAssistantMessageId;
  if (!assistantMessageId) {
    return undefined;
  }
  const row = getMessageById(assistantMessageId, conversationId);
  if (!row || row.createdAt < runStartedAt) {
    return undefined;
  }
  return row;
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

    // The run delivered around the pipeline — an email through the messaging
    // tool, a Slack post through the Web API. The user has the result; a
    // notification reading "posted it" on top would be the duplicate.
    const runRows = collectRunRows(latestRow, conversationId, runStartedAt);
    if (runRows.some((row) => row.content.some(isDirectDelivery))) {
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
