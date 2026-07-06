/**
 * Subagent → parent notification, decoupled from the SubagentManager.
 *
 * The child → parent relation and the subagent's lifecycle status are read
 * from the persisted subagent record (see `persistence/subagent-store`), so
 * these helpers do not depend on the live manager and can be imported by tool
 * modules without pulling the conversation/agent-loop core into their graph.
 *
 * Delivery still targets the parent's in-process `Conversation` via the
 * conversation registry: a notification is injected only when the parent
 * conversation is live in this process.
 */

import { findConversation } from "../daemon/conversation-registry.js";
import { getSubagentRecordByConversationId } from "../persistence/subagent-store.js";
import { getLogger } from "../util/logger.js";
import { type SubagentStatus, TERMINAL_STATUSES } from "./types.js";

const log = getLogger("subagent-notify");

/**
 * Enqueue (or persist + run) `message` as a user-role turn in the parent
 * conversation. No-op with a warning when the parent conversation is not live
 * in this process.
 *
 * Shared by the child-triggered {@link notifyParentFromChild} and the
 * manager's terminal/abort injections so every subagent → parent turn lands
 * through one path.
 */
export function injectMessageIntoParent(
  parentConversationId: string,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  const parentConversation = findConversation(parentConversationId);
  if (!parentConversation) {
    log.warn(
      { parentConversationId },
      "Subagent notification target parent conversation not found",
    );
    return;
  }
  const enqueueResult = parentConversation.enqueueMessage({
    content: message,
    metadata,
  });
  if (!enqueueResult.queued && !enqueueResult.rejected) {
    parentConversation
      .persistUserMessage({ content: message, metadata })
      .then(({ id: messageId }) =>
        parentConversation.runAgentLoop(message, messageId),
      )
      .catch((err) => {
        log.error(
          { parentConversationId, err },
          "Failed to process subagent notification in parent",
        );
      });
  }
}

/**
 * Deliver a mid-run notification from a subagent to its parent conversation.
 *
 * Returns `false` when `childConversationId` is not a subagent, or when the
 * subagent has already reached a terminal status (the parent receives the
 * terminal summary through a separate path); `true` when the notification was
 * injected into the parent.
 */
export function notifyParentFromChild(
  childConversationId: string,
  message: string,
  urgency: string,
): boolean {
  const record = getSubagentRecordByConversationId(childConversationId);
  if (!record) {
    return false;
  }
  if (TERMINAL_STATUSES.has(record.status as SubagentStatus)) {
    return false;
  }

  const prefix = record.isFork ? "Fork" : "Subagent";
  let notificationString = `[${prefix} "${record.label}" — ${urgency}] ${message}`;
  if (urgency === "blocked") {
    notificationString += `\nUse subagent_message to send guidance to this ${prefix.toLowerCase()}.`;
  }

  injectMessageIntoParent(record.parentConversationId, notificationString, {
    subagentNotification: {
      subagentId: record.id,
      label: record.label,
      status: "running" as const,
      conversationId: record.conversationId,
      objective: record.objective,
    },
  });
  return true;
}
