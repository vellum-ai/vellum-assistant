import type { Conversation } from "../daemon/conversation.js";
import {
  allSubagentConversations,
  findConversation,
} from "../daemon/conversation-registry.js";
import {
  getSubagentRecordByConversationId,
  getSubagentRecordsByParent,
} from "../persistence/subagent-store.js";
import { hasPendingAgentWake } from "../runtime/agent-wake-queue.js";
import { TERMINAL_STATUSES } from "../subagent/types.js";
import { hasBackgroundToolWork } from "../tools/background-tool-registry.js";
import { isUserFacingSubagent, workStartedAfter } from "./completion-work.js";

function hasPendingTurn(
  conversation: Conversation | undefined,
  startedAfter?: number,
): boolean {
  if (!conversation) {
    return false;
  }
  if (
    conversation.isProcessing() &&
    (startedAfter === undefined ||
      conversation.currentTurnWorkOrigins === undefined ||
      conversation.currentTurnWorkOrigins.some((origin) =>
        workStartedAfter(origin, startedAfter),
      ))
  ) {
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
      .some((message) => workStartedAfter(message, startedAfter)) ||
    [...(conversation.pendingQueuedDispatches?.values() ?? [])].some(
      (dispatches) =>
        [...dispatches].some((dispatch) =>
          dispatch.messages.some((message) =>
            workStartedAfter(message, startedAfter),
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
    hasPendingAgentWake(conversationId, undefined, options) ||
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
