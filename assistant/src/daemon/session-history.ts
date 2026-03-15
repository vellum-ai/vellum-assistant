import { v4 as uuid } from "uuid";

import { getSummaryFromContextMessage } from "../context/window-manager.js";
import {
  deleteLastExchange,
  deleteMessageById,
  getMessages,
  relinkAttachments,
  updateMessageContent,
} from "../memory/conversation-crud.js";
import { isLastUserMessageToolResult } from "../memory/conversation-queries.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import { withQdrantBreaker } from "../memory/qdrant-circuit-breaker.js";
import { getQdrantClient } from "../memory/qdrant-client.js";
import type { ContentBlock, Message } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import type { ServerMessage } from "./message-protocol.js";
import type { TraceEmitter } from "./trace-emitter.js";

const log = getLogger("session-history");

// ── Helpers ──────────────────────────────────────────────────────────

function isToolResultBlock(
  block: ContentBlock | Record<string, unknown>,
): boolean {
  return (
    block.type === "tool_result" || block.type === "web_search_tool_result"
  );
}

function isUndoableUserMessage(message: Message): boolean {
  if (message.role !== "user") return false;
  if (getSummaryFromContextMessage(message) != null) return false;
  // A user message is undoable if it contains user-authored content (non-tool_result
  // blocks). Messages that contain ONLY tool_result blocks (e.g. automated tool
  // responses) are not undoable. Messages that have both tool_result and text blocks
  // (e.g. after repairHistory merges a tool_result turn with a user prompt) are still
  // undoable because they contain real user content.
  const hasNonToolResultContent = message.content.some(
    (block) => !isToolResultBlock(block),
  );
  if (!hasNonToolResultContent) return false;
  return true;
}

export function findLastUndoableUserMessageIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUndoableUserMessage(messages[i])) {
      return i;
    }
  }
  return -1;
}

// ── Qdrant Vector Cleanup ────────────────────────────────────────────

/**
 * Delete Qdrant vector entries for the given segment and item IDs.
 * Individual deletion failures are logged and enqueued as retry jobs
 * to prevent silently orphaned vectors.
 */
export async function cleanupQdrantVectors(
  conversationId: string,
  segmentIds: string[],
  orphanedItemIds: string[],
): Promise<void> {
  let qdrant: ReturnType<typeof getQdrantClient>;
  try {
    qdrant = getQdrantClient();
  } catch {
    return; // Qdrant not initialized — nothing to clean up.
  }

  if (segmentIds.length === 0 && orphanedItemIds.length === 0) return;

  const targets: Array<{ targetType: string; targetId: string }> = [];
  for (const segId of segmentIds) {
    targets.push({ targetType: "segment", targetId: segId });
  }
  for (const itemId of orphanedItemIds) {
    targets.push({ targetType: "item", targetId: itemId });
  }

  const results = await Promise.allSettled(
    targets.map((t) =>
      withQdrantBreaker(() => qdrant.deleteByTarget(t.targetType, t.targetId)),
    ),
  );

  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      succeeded++;
    } else {
      failed++;
      const { targetType, targetId } = targets[i];
      log.warn(
        { err: result.reason, targetType, targetId, conversationId },
        "Qdrant vector deletion failed, enqueuing retry job",
      );
      enqueueMemoryJob("delete_qdrant_vectors", { targetType, targetId });
    }
  }

  if (succeeded > 0) {
    log.info(
      {
        conversationId,
        succeeded,
        failed,
        segments: segmentIds.length,
        items: orphanedItemIds.length,
      },
      "Cleaned up Qdrant vectors after regenerate",
    );
  }
}

// ── Consolidation ────────────────────────────────────────────────────

/**
 * Consolidate consecutive assistant messages created during an agent loop.
 * After the loop completes, merge all assistant messages that came after
 * the user message into a single message, and delete the internal tool_result
 * user messages. This ensures the database matches what the client sees
 * during streaming (one consolidated message per user request).
 */
export function consolidateAssistantMessages(
  conversationId: string,
  userMessageId: string,
): void {
  const allMessages = getMessages(conversationId);
  const userMsgIndex = allMessages.findIndex((m) => m.id === userMessageId);
  if (userMsgIndex === -1) return;

  const messagesToConsolidate: typeof allMessages = [];
  const internalToolResultMessages: typeof allMessages = [];
  const messagesToDelete: string[] = [];

  // Collect all assistant messages and internal tool_result user messages after this user message
  for (let i = userMsgIndex + 1; i < allMessages.length; i++) {
    const msg = allMessages[i];
    if (msg.role === "assistant") {
      messagesToConsolidate.push(msg);
    } else if (msg.role === "user") {
      // Check if this is an internal tool_result message (no text, only tool_result blocks)
      try {
        const content = JSON.parse(msg.content);
        const isToolResultOnly =
          Array.isArray(content) &&
          content.every((block: Record<string, unknown>) =>
            isToolResultBlock(block),
          ) &&
          content.length > 0;
        if (isToolResultOnly) {
          internalToolResultMessages.push(msg);
          messagesToDelete.push(msg.id);
        } else {
          // Hit a real user message, stop consolidating
          break;
        }
      } catch {
        // Can't parse, assume it's a real user message
        break;
      }
    }
  }

  // Only consolidate if there are multiple assistant messages
  if (messagesToConsolidate.length <= 1) {
    // Still delete internal tool_result messages even if only one assistant message,
    // and collect IDs for vector cleanup
    const allSegmentIds: string[] = [];
    const allOrphanedItemIds: string[] = [];
    for (const id of messagesToDelete) {
      const deleted = deleteMessageById(id);
      allSegmentIds.push(...deleted.segmentIds);
      allOrphanedItemIds.push(...deleted.orphanedItemIds);
    }

    // Clean up Qdrant vectors (fire-and-forget)
    if (allSegmentIds.length > 0 || allOrphanedItemIds.length > 0) {
      cleanupQdrantVectors(
        conversationId,
        allSegmentIds,
        allOrphanedItemIds,
      ).catch((err) => {
        log.warn(
          { err, conversationId },
          "Qdrant cleanup after consolidation failed (non-fatal)",
        );
      });
    }
    return;
  }

  log.info(
    {
      conversationId,
      userMessageId,
      assistantCount: messagesToConsolidate.length,
      internalMessageCount: messagesToDelete.length,
    },
    "Consolidating assistant messages",
  );

  // Merge all content blocks from all assistant messages AND tool_result blocks from internal user messages
  const consolidatedContent: ContentBlock[] = [];
  for (const msg of messagesToConsolidate) {
    try {
      const content = JSON.parse(msg.content);
      if (Array.isArray(content)) {
        const toolUseBlocks = content.filter(
          (b: Record<string, unknown>) => b.type === "tool_use",
        );
        log.info(
          {
            messageId: msg.id,
            blockCount: content.length,
            toolUseCount: toolUseBlocks.length,
          },
          "Consolidating assistant message content",
        );
        consolidatedContent.push(...content);
      }
    } catch (err) {
      log.warn(
        { err, messageId: msg.id },
        "Failed to parse message content during consolidation",
      );
    }
  }

  // Also merge tool_result blocks from internal user messages
  for (const msg of internalToolResultMessages) {
    try {
      const content = JSON.parse(msg.content);
      if (Array.isArray(content)) {
        const toolResultBlocks = content.filter((b: Record<string, unknown>) =>
          isToolResultBlock(b),
        );
        log.info(
          {
            messageId: msg.id,
            blockCount: content.length,
            toolResultCount: toolResultBlocks.length,
          },
          "Merging tool_result blocks from internal user message",
        );
        consolidatedContent.push(...content);
      }
    } catch (err) {
      log.warn(
        { err, messageId: msg.id },
        "Failed to parse internal tool_result message during consolidation",
      );
    }
  }

  const toolUseBlocksInConsolidated = consolidatedContent.filter(
    (b) => b.type === "tool_use",
  ).length;
  const toolResultBlocksInConsolidated = consolidatedContent.filter((b) =>
    isToolResultBlock(b),
  ).length;
  log.info(
    {
      totalBlocks: consolidatedContent.length,
      toolUseBlocks: toolUseBlocksInConsolidated,
      toolResultBlocks: toolResultBlocksInConsolidated,
    },
    "Final consolidated content",
  );

  // Update the first assistant message with all content
  const firstAssistantMsg = messagesToConsolidate[0];
  updateMessageContent(
    firstAssistantMsg.id,
    JSON.stringify(consolidatedContent),
  );

  // Re-link attachments from messages about to be deleted to the consolidated
  // message. Without this, ON DELETE CASCADE on message_attachments destroys
  // the attachment links, and deleteOrphanAttachments removes the data.
  const messageIdsToDelete = [
    ...messagesToConsolidate.slice(1).map((m) => m.id),
    ...messagesToDelete,
  ];
  if (messageIdsToDelete.length > 0) {
    const relinked = relinkAttachments(
      messageIdsToDelete,
      firstAssistantMsg.id,
    );
    if (relinked > 0) {
      log.info(
        { relinked, targetMessageId: firstAssistantMsg.id },
        "Re-linked attachments to consolidated message",
      );
    }
  }

  // Delete the other assistant messages and internal tool_result messages,
  // and collect IDs for vector cleanup
  const allSegmentIds: string[] = [];
  const allOrphanedItemIds: string[] = [];
  for (let i = 1; i < messagesToConsolidate.length; i++) {
    const deleted = deleteMessageById(messagesToConsolidate[i].id);
    allSegmentIds.push(...deleted.segmentIds);
    allOrphanedItemIds.push(...deleted.orphanedItemIds);
  }
  for (const id of messagesToDelete) {
    const deleted = deleteMessageById(id);
    allSegmentIds.push(...deleted.segmentIds);
    allOrphanedItemIds.push(...deleted.orphanedItemIds);
  }

  // Clean up Qdrant vectors (fire-and-forget)
  if (allSegmentIds.length > 0 || allOrphanedItemIds.length > 0) {
    cleanupQdrantVectors(
      conversationId,
      allSegmentIds,
      allOrphanedItemIds,
    ).catch((err) => {
      log.warn(
        { err, conversationId },
        "Qdrant cleanup after consolidation failed (non-fatal)",
      );
    });
  }

  log.info(
    {
      conversationId,
      consolidatedMessageId: firstAssistantMsg.id,
      deletedCount: messagesToConsolidate.length - 1 + messagesToDelete.length,
    },
    "Assistant messages consolidated",
  );
}

// ── Undo ─────────────────────────────────────────────────────────────

/**
 * Subset of Session state that undo/regenerate need access to.
 */
export interface HistorySessionContext {
  readonly conversationId: string;
  readonly traceEmitter: TraceEmitter;
  messages: Message[];
  processing: boolean;
  abortController: AbortController | null;
  currentRequestId?: string;
  runAgentLoop(
    content: string,
    userMessageId: string,
    onEvent: (msg: ServerMessage) => void,
    options?: {
      skipPreMessageRollback?: boolean;
      isUserMessage?: boolean;
      titleText?: string;
    },
  ): Promise<void>;
}

/**
 * Remove the last user+assistant exchange from memory and DB.
 * Returns the number of messages removed.
 */
export function undo(session: HistorySessionContext): number {
  if (session.processing) return 0;

  const lastUserIdx = findLastUndoableUserMessageIndex(session.messages);
  if (lastUserIdx === -1) return 0;

  const removed = session.messages.length - lastUserIdx;
  session.messages = session.messages.slice(0, lastUserIdx);

  // Also remove from DB. We may need to call deleteLastExchange multiple
  // times because the DB stores tool_result user messages as separate rows.
  // The in-memory findLastUndoableUserMessageIndex skips these, but the DB's
  // deleteLastExchange only finds the last role='user' row — which may be a
  // tool_result message, leaving the real user message orphaned.
  //
  // Strategy: peel back any trailing tool_result exchanges first, then
  // delete the real user message exchange only if tool_result rows were
  // actually encountered. The do-while handles the case where the last DB
  // exchange is a tool_result row; the flag ensures we only issue the extra
  // deleteLastExchange when the loop peeled back tool_result messages.
  let hadToolResult = false;
  do {
    deleteLastExchange(session.conversationId);
    if (isLastUserMessageToolResult(session.conversationId)) {
      hadToolResult = true;
    } else {
      break;
    }
  } while (true);
  if (hadToolResult) {
    deleteLastExchange(session.conversationId);
  }

  return removed;
}

// ── Regenerate ───────────────────────────────────────────────────────

/**
 * Regenerate the last assistant response: remove the assistant's reply
 * (and any intermediate tool_result messages) from memory, DB, and
 * Qdrant, then re-run the agent loop with the same user message.
 */
export async function regenerate(
  session: HistorySessionContext,
  onEvent: (msg: ServerMessage) => void,
  requestId?: string,
): Promise<void> {
  if (session.processing) {
    onEvent({ type: "error", message: "Cannot regenerate while processing" });
    if (requestId) {
      session.traceEmitter.emit(
        "request_error",
        "Cannot regenerate while processing",
        {
          requestId,
          status: "error",
          attributes: { reason: "already_processing" },
        },
      );
    }
    return;
  }

  // Find the last undoable user message — everything after it is the
  // assistant's exchange that we want to regenerate.
  const lastUserIdx = findLastUndoableUserMessageIndex(session.messages);
  if (lastUserIdx === -1) {
    onEvent({ type: "error", message: "No messages to regenerate" });
    if (requestId) {
      session.traceEmitter.emit("request_error", "No messages to regenerate", {
        requestId,
        status: "error",
        attributes: { reason: "no_messages" },
      });
    }
    return;
  }

  // There must be at least one message after the user message (the assistant reply).
  if (lastUserIdx >= session.messages.length - 1) {
    onEvent({ type: "error", message: "No assistant response to regenerate" });
    if (requestId) {
      session.traceEmitter.emit(
        "request_error",
        "No assistant response to regenerate",
        {
          requestId,
          status: "error",
          attributes: { reason: "no_assistant_response" },
        },
      );
    }
    return;
  }

  // Remove the assistant's exchange from in-memory history (keep the user message).
  session.messages = session.messages.slice(0, lastUserIdx + 1);

  // Find DB message IDs to delete: get all messages from the DB, then
  // identify the ones that come after the last user message.
  const dbMessages = getMessages(session.conversationId);

  // Walk backwards to find the last real (non-tool_result) user message in the DB.
  let dbUserMsgIdx = -1;
  for (let i = dbMessages.length - 1; i >= 0; i--) {
    if (dbMessages[i].role !== "user") continue;
    try {
      const parsed = JSON.parse(dbMessages[i].content);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((b: Record<string, unknown>) => isToolResultBlock(b))
      ) {
        continue; // Skip tool_result-only user messages
      }
    } catch {
      /* plain text = real user message */
    }
    dbUserMsgIdx = i;
    break;
  }

  if (dbUserMsgIdx === -1) {
    onEvent({ type: "error", message: "No user message found in DB" });
    if (requestId) {
      session.traceEmitter.emit(
        "request_error",
        "No user message found in DB",
        {
          requestId,
          status: "error",
          attributes: { reason: "no_db_user_message" },
        },
      );
    }
    return;
  }

  // Capture the existing DB user message ID so we can pass it to
  // runAgentLoop without re-persisting the user message.
  const existingUserMessageId = dbMessages[dbUserMsgIdx].id;

  // Everything after the user message needs to be deleted.
  const messagesToDelete = dbMessages.slice(dbUserMsgIdx + 1);

  // Delete each message via deleteMessageById and collect IDs for Qdrant cleanup.
  const allSegmentIds: string[] = [];
  const allOrphanedItemIds: string[] = [];
  for (const msg of messagesToDelete) {
    const deleted = deleteMessageById(msg.id);
    allSegmentIds.push(...deleted.segmentIds);
    allOrphanedItemIds.push(...deleted.orphanedItemIds);
  }

  // Clean up Qdrant vectors (fire-and-forget).
  cleanupQdrantVectors(
    session.conversationId,
    allSegmentIds,
    allOrphanedItemIds,
  ).catch((err) => {
    log.warn(
      { err, conversationId: session.conversationId },
      "Qdrant cleanup after regenerate failed (non-fatal)",
    );
  });

  // Re-extract the user message content for the agent loop.
  // Use all content blocks (text, image, file) so attachments are
  // preserved — not just text blocks.
  const userMessage = session.messages[lastUserIdx];
  const textBlocks = userMessage.content.filter((b) => b.type === "text");
  const content = textBlocks
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  // Notify client that the old response has been removed.
  onEvent({
    type: "undo_complete",
    removedCount: messagesToDelete.length,
    conversationId: session.conversationId,
  });

  // Set up processing state manually and call runAgentLoop directly,
  // bypassing processMessage to avoid duplicating the user message
  // in both this.messages and the DB.
  session.processing = true;
  session.abortController = new AbortController();
  session.currentRequestId = requestId ?? uuid();

  await session.runAgentLoop(content, existingUserMessageId, onEvent, {
    skipPreMessageRollback: true,
    isUserMessage: true,
  });
}
