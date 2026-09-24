import type pino from "pino";

import { isToolResultOnlyUserMessage } from "../conversations/message-consolidation.js";
import {
  getAttentionStateByConversationIds,
  hasUnseenLatestAssistantMessage,
} from "../persistence/conversation-attention-store.js";
import {
  type ConversationRow,
  getConversation,
  getMessageById,
  getRecentConversationMessages,
  isStandaloneAssistantMessage,
  type MessageRow,
  parseMessageMetadata,
} from "../persistence/conversation-crud.js";
import { isReplaceableTitle } from "../persistence/conversation-title-placeholders.js";
import {
  isEchoSuppressedUserMessage,
  resolveConversationKind,
} from "../persistence/conversation-types.js";
import { getSubagentRecordById } from "../persistence/subagent-store.js";
import type { CompletionContext } from "./completion-policy.js";
import { isUserFacingSubagent } from "./completion-work.js";
import { emitNotificationSignal } from "./emit-signal.js";
import { hasNotifiedSourceContextSince } from "./events-store.js";
import { hasPendingBackgroundWork } from "./has-pending-background-work.js";
import { sanitizeNotificationTitle } from "./notification-utils.js";
import {
  resolveCompletionRecipientPrincipalId,
  resolveCompletionVisibleInSourceNow,
} from "./resolve-visible-in-source.js";
import {
  collectRunRows,
  deliveredThroughMessagingTool,
  resolveLatestRunRow,
  resolveRunResult,
} from "./result-output.js";

const RESULT_EVENT_NAMES = ["assistant.share", "activity.complete"] as const;
const COMPLETION_HISTORY_LIMIT = 200;

interface CompletedWork {
  workId: string;
  childConversationId?: string;
  startedAt: number;
}

/** Existing terminal records opt parent continuations into completion delivery. */
function resolveCompletedWork(
  conversationId: string,
  trigger: MessageRow,
  turnTrigger: MessageRow,
): CompletedWork | undefined {
  const metadata = parseMessageMetadata(trigger.metadata);
  const turnMetadata =
    trigger.id === turnTrigger.id
      ? metadata
      : parseMessageMetadata(turnTrigger.metadata);
  if (
    !metadata ||
    !turnMetadata ||
    turnMetadata.turnOutcome !== undefined ||
    (trigger.id !== turnTrigger.id &&
      (metadata.turnOutcome !== "batched" ||
        metadata.turnBatchedInto !== turnTrigger.id)) ||
    metadata.voiceSessionTurn === true ||
    turnMetadata.voiceSessionTurn === true
  ) {
    return undefined;
  }
  const terminal = metadata.subagentNotification;
  if (terminal?.status === "completed") {
    const task = getSubagentRecordById(terminal.subagentId);
    if (
      !task ||
      task.status !== "completed" ||
      task.parentConversationId !== conversationId ||
      task.conversationId !== terminal.conversationId ||
      !isUserFacingSubagent(task)
    ) {
      return undefined;
    }
    return {
      workId: `subagent:${task.id}`,
      childConversationId: task.conversationId,
      startedAt: task.startedAt ?? task.createdAt,
    };
  }
  const tool = metadata.backgroundToolCompletion;
  if (
    metadata.backgroundEventSource === "background-tool" &&
    tool?.status === "completed" &&
    tool.conversationId === conversationId
  ) {
    return { workId: `tool:${tool.id}`, startedAt: tool.startedAt };
  }
  return undefined;
}

function isInternalTurnTrigger(row: MessageRow): boolean {
  const metadata = parseMessageMetadata(row.metadata);
  return metadata?.automated === true || isEchoSuppressedUserMessage(metadata);
}

function* completionCandidates(
  conversationId: string,
  trigger: MessageRow,
  result: MessageRow | undefined,
): Generator<{
  trigger: MessageRow;
  turnTrigger: MessageRow;
  result: MessageRow;
  work: CompletedWork;
}> {
  if (!isInternalTurnTrigger(trigger)) {
    return;
  }
  let beforeMessageId: string | undefined;
  let foundTrigger = false;
  let resultInCurrentTurn = false;
  let previousResult: MessageRow | undefined;
  let sharedTurn: { trigger: MessageRow; result: MessageRow } | undefined;
  while (true) {
    const history = getRecentConversationMessages(
      conversationId,
      COMPLETION_HISTORY_LIMIT,
      beforeMessageId,
    );
    for (let index = history.length - 1; index >= 0; index--) {
      const row = history[index];
      if (!foundTrigger) {
        if (row.id === trigger.id) {
          foundTrigger = true;
          previousResult = resultInCurrentTurn ? result : undefined;
        } else {
          if (row.role === "user" && !isToolResultOnlyUserMessage(row)) {
            return;
          }
          if (row.id === result?.id) {
            resultInCurrentTurn = true;
          }
          continue;
        }
      }
      if (
        row.role === "assistant" &&
        !isStandaloneAssistantMessage(row.role, row.metadata)
      ) {
        previousResult ??= row;
        sharedTurn = undefined;
      } else if (row.role === "user" && !isToolResultOnlyUserMessage(row)) {
        if (!isInternalTurnTrigger(row)) {
          return;
        }
        const metadata = parseMessageMetadata(row.metadata);
        if (metadata?.turnOutcome !== "batched") {
          sharedTurn = previousResult
            ? { trigger: row, result: previousResult }
            : undefined;
        } else if (metadata.turnBatchedInto !== sharedTurn?.trigger.id) {
          sharedTurn = undefined;
        }
        if (sharedTurn) {
          const work = resolveCompletedWork(
            conversationId,
            row,
            sharedTurn.trigger,
          );
          if (work) {
            yield {
              trigger: row,
              turnTrigger: sharedTurn.trigger,
              result: sharedTurn.result,
              work,
            };
          }
        }
        previousResult = undefined;
      }
    }
    if (history.length < COMPLETION_HISTORY_LIMIT) {
      return;
    }
    beforeMessageId = history[0].id;
  }
}

function childDeliveredResult(work: CompletedWork): boolean {
  const childId = work.childConversationId;
  if (!childId) {
    return false;
  }
  if (
    hasNotifiedSourceContextSince(childId, work.startedAt, RESULT_EVENT_NAMES)
  ) {
    return true;
  }
  const latest = resolveLatestRunRow(childId, work.startedAt);
  return (
    latest !== undefined &&
    deliveredThroughMessagingTool(
      childId,
      collectRunRows(latest, childId, work.startedAt),
    )
  );
}

function canNotifyConversation(
  conversation: ConversationRow | null | undefined,
): conversation is ConversationRow {
  return (
    conversation != null &&
    conversation.archivedAt == null &&
    resolveConversationKind(
      conversation.source,
      conversation.conversationType,
    ) === "user"
  );
}

/** Notify only after a successful parent turn persists the requested result. */
export async function emitBackgroundResultNotification(params: {
  conversationId: string;
  assistantMessageId?: string;
  userMessageId: string | undefined;
  recoverOnly?: boolean;
  cronRunId?: string | null;
  conversation?: ConversationRow | null;
  rlog: pino.Logger;
}): Promise<void> {
  const { conversationId, assistantMessageId, userMessageId, rlog } = params;
  try {
    if (!userMessageId || params.cronRunId) {
      return;
    }
    if (
      !canNotifyConversation(
        params.conversation ?? getConversation(conversationId),
      )
    ) {
      return;
    }
    const recipientPrincipalId =
      await resolveCompletionRecipientPrincipalId(rlog);
    if (!recipientPrincipalId) {
      return;
    }
    const visibleInSourceNow = await resolveCompletionVisibleInSourceNow({
      conversationId,
      actorPrincipalId: recipientPrincipalId,
      logger: rlog,
    });
    // Eligibility reads stay together after all asynchronous lookups.
    const conversation = getConversation(conversationId);
    if (!canNotifyConversation(conversation)) {
      return;
    }
    const trigger = getMessageById(userMessageId, conversationId);
    if (!trigger) {
      return;
    }
    // A parent that only launched more work has not produced the final result.
    if (hasPendingBackgroundWork(conversationId)) {
      return;
    }
    const attention = getAttentionStateByConversationIds([conversationId]).get(
      conversationId,
    );
    if (
      !hasUnseenLatestAssistantMessage(attention) ||
      (assistantMessageId !== undefined &&
        attention?.latestAssistantMessageId !== assistantMessageId)
    ) {
      return;
    }
    const latestId = assistantMessageId ?? attention?.latestAssistantMessageId;
    const latestResult = latestId
      ? (getMessageById(latestId, conversationId) ?? undefined)
      : undefined;
    for (const candidate of completionCandidates(
      conversationId,
      trigger,
      params.recoverOnly ? undefined : latestResult,
    )) {
      const {
        work,
        result,
        trigger: successfulTrigger,
        turnTrigger,
      } = candidate;
      if (
        result.role !== "assistant" ||
        result.finalized !== 1 ||
        isStandaloneAssistantMessage(result.role, result.metadata)
      ) {
        continue;
      }
      if (
        result.createdAt <= (attention?.lastSeenAssistantMessageAt ?? -Infinity)
      ) {
        return;
      }
      if (
        hasNotifiedSourceContextSince(
          conversationId,
          successfulTrigger.createdAt,
          RESULT_EVENT_NAMES,
        )
      ) {
        return;
      }
      if (childDeliveredResult(work)) {
        continue;
      }
      const rows = collectRunRows(
        result,
        conversationId,
        turnTrigger.createdAt,
      );
      if (deliveredThroughMessagingTool(conversationId, rows)) {
        return;
      }
      const output = resolveRunResult(rows);
      if (!output) {
        continue;
      }
      if (
        output.row.createdAt <=
        (attention?.lastSeenAssistantMessageAt ?? -Infinity)
      ) {
        return;
      }
      const completion: CompletionContext = {
        workId: work.workId,
        conversationId,
        recipientPrincipalId,
        owner: "parent_continuation",
      };
      const storedTitle = conversation.title?.trim() ?? "";
      const requestedTitle = isReplaceableTitle(storedTitle)
        ? undefined
        : sanitizeNotificationTitle(storedTitle.replace(/\s+/g, " "));
      await emitNotificationSignal({
        sourceEventName: "activity.complete",
        sourceChannel: "assistant_tool",
        sourceContextId: conversationId,
        attentionHints: {
          requiresAction: false,
          urgency: "medium",
          isAsyncBackground: true,
          visibleInSourceNow,
        },
        contextPayload: {
          completion,
          ...(requestedTitle ? { requestedTitle } : {}),
          requestedMessage: output.body,
        },
        dedupeKey: `activity.complete:${conversationId}:${work.workId}`,
      });
      return;
    }
  } catch (err) {
    rlog.warn(
      { err, conversationId, assistantMessageId },
      "Failed to emit background result notification (non-fatal)",
    );
  }
}
