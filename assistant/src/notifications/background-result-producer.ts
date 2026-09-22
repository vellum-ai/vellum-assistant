import type pino from "pino";

import {
  getAttentionStateByConversationIds,
  hasUnseenLatestAssistantMessage,
} from "../persistence/conversation-attention-store.js";
import {
  type ConversationRow,
  getConversation,
  getMessageById,
  type MessageRow,
  parseMessageMetadata,
} from "../persistence/conversation-crud.js";
import { isReplaceableTitle } from "../persistence/conversation-title-placeholders.js";
import { resolveConversationKind } from "../persistence/conversation-types.js";
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
  resolveRunOutput,
} from "./result-output.js";

const RESULT_EVENT_NAMES = ["assistant.share", "activity.complete"] as const;

interface CompletedWork {
  workId: string;
  childConversationId?: string;
  startedAt: number;
}

/** Existing terminal records opt parent continuations into completion delivery. */
function resolveCompletedWork(
  conversationId: string,
  trigger: MessageRow,
): CompletedWork | undefined {
  const metadata = parseMessageMetadata(trigger.metadata);
  if (
    !metadata ||
    metadata.voiceSessionTurn === true ||
    (metadata.assistantMessageChannel &&
      metadata.assistantMessageChannel !== "vellum")
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

/** Notify only after a successful parent turn persists the requested result. */
export async function emitBackgroundResultNotification(params: {
  conversationId: string;
  assistantMessageId: string;
  userMessageId: string | undefined;
  cronRunId?: string | null;
  conversation?: ConversationRow | null;
  rlog: pino.Logger;
}): Promise<void> {
  const { conversationId, assistantMessageId, userMessageId, rlog } = params;
  try {
    if (!userMessageId || params.cronRunId) {
      return;
    }
    const conversation = params.conversation ?? getConversation(conversationId);
    if (
      !conversation ||
      resolveConversationKind(
        conversation.source,
        conversation.conversationType,
      ) !== "user"
    ) {
      return;
    }
    const trigger = getMessageById(userMessageId, conversationId);
    const result = getMessageById(assistantMessageId, conversationId);
    if (
      !trigger ||
      !result ||
      result.role !== "assistant" ||
      result.finalized !== 1 ||
      result.createdAt < trigger.createdAt
    ) {
      return;
    }
    const work = resolveCompletedWork(conversationId, trigger);
    if (!work) {
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
      attention?.latestAssistantMessageId !== assistantMessageId
    ) {
      return;
    }
    if (
      hasNotifiedSourceContextSince(
        conversationId,
        trigger.createdAt,
        RESULT_EVENT_NAMES,
      ) ||
      childDeliveredResult(work)
    ) {
      return;
    }
    const rows = collectRunRows(result, conversationId, trigger.createdAt);
    if (deliveredThroughMessagingTool(conversationId, rows)) {
      return;
    }
    const body = resolveRunOutput(rows);
    if (!body) {
      return;
    }
    const recipientPrincipalId =
      await resolveCompletionRecipientPrincipalId(rlog);
    if (!recipientPrincipalId) {
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
        visibleInSourceNow: await resolveCompletionVisibleInSourceNow({
          conversationId,
          actorPrincipalId: recipientPrincipalId,
          logger: rlog,
        }),
      },
      contextPayload: {
        completion,
        ...(requestedTitle ? { requestedTitle } : {}),
        requestedMessage: body,
      },
      dedupeKey: `activity.complete:${conversationId}:${work.workId}`,
    });
  } catch (err) {
    rlog.warn(
      { err, conversationId, assistantMessageId },
      "Failed to emit background result notification (non-fatal)",
    );
  }
}
