import type { Conversation } from "../daemon/conversation.js";
import type { QueuedMessage } from "../daemon/conversation-queue-manager.js";
import {
  allSubagentConversations,
  findConversation,
} from "../daemon/conversation-registry.js";
import {
  getSubagentRecordByConversationId,
  getSubagentRecordById,
  getSubagentRecordsByParent,
} from "../persistence/subagent-store.js";
import { hasPendingAgentWake } from "../runtime/agent-wake-queue.js";
import { TERMINAL_STATUSES } from "../subagent/types.js";
import { hasBackgroundToolWork } from "../tools/background-tool-registry.js";
import { isUserFacingSubagent } from "./completion-work.js";

function queuedWorkStartedAfter(
  message: QueuedMessage,
  cutoff: number,
): boolean {
  const taskNotification = message.metadata?.subagentNotification;
  if (
    taskNotification &&
    typeof taskNotification === "object" &&
    "subagentId" in taskNotification &&
    typeof taskNotification.subagentId === "string"
  ) {
    const task = getSubagentRecordById(taskNotification.subagentId);
    if (task) {
      return isUserFacingSubagent(task) && task.createdAt >= cutoff;
    }
  }
  const command = message.metadata?.backgroundToolCompletion;
  if (
    message.metadata?.backgroundEventSource === "background-tool" &&
    command &&
    typeof command === "object" &&
    "startedAt" in command &&
    typeof command.startedAt === "number"
  ) {
    return command.startedAt >= cutoff;
  }
  return message.sentAt >= cutoff;
}

function hasPendingTurn(
  conversation: Conversation | undefined,
  startedAfter?: number,
): boolean {
  if (!conversation) {
    return false;
  }
  if (conversation.isProcessing()) {
    return true;
  }
  if (startedAfter === undefined) {
    return (
      conversation.hasQueuedMessages() ||
      (conversation.pendingQueuedDispatches?.size ?? 0) > 0
    );
  }
  return (
    conversation
      .snapshotQueuedMessages()
      .some((message) => queuedWorkStartedAfter(message, startedAfter)) ||
    [...(conversation.pendingQueuedDispatches?.values() ?? [])].some(
      (dispatches) =>
        [...dispatches].some((dispatch) =>
          dispatch.messages.some((message) =>
            queuedWorkStartedAfter(message, startedAfter),
          ),
        ),
    )
  );
}

/** A finished turn can still own delegated work whose result is not ready. */
export function hasPendingBackgroundWork(
  conversationId: string,
  options?: { startedAfter?: number },
): boolean {
  const conversation = findConversation(conversationId);
  // Terminal records can retain a live child while its queued follow-ups drain.
  for (const child of allSubagentConversations()) {
    if (
      child.parentConversationId !== conversationId ||
      !hasPendingTurn(child)
    ) {
      continue;
    }
    const task = getSubagentRecordByConversationId(child.conversationId);
    if (
      task &&
      isUserFacingSubagent(task) &&
      (options?.startedAfter === undefined ||
        task.createdAt >= options.startedAfter)
    ) {
      return true;
    }
  }
  return (
    hasPendingTurn(conversation, options?.startedAfter) ||
    // A newer human turn can finish inside the earlier wake's queue drain.
    (options?.startedAfter === undefined &&
      hasPendingAgentWake(conversationId)) ||
    getSubagentRecordsByParent(conversationId, {
      terminalStatuses: [...TERMINAL_STATUSES],
      maxTerminal: 0,
    }).some(
      (task) =>
        isUserFacingSubagent(task) &&
        (options?.startedAfter === undefined ||
          task.createdAt >= options.startedAfter),
    ) ||
    hasBackgroundToolWork(conversationId, options)
  );
}
