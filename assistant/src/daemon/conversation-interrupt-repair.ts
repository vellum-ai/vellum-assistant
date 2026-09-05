/**
 * Repair a conversation history an abort cut off mid-tool.
 *
 * Its own module rather than a helper inside the drain or the interrupt,
 * because both reach it: the queue drain arms it with the pending-repair flags
 * and the interrupt path forces it, and neither of those two modules should
 * have to import the other to share it.
 */

import { addMessage } from "../persistence/conversation-crud.js";
import { PREEMPTED_TOOL_RESULT_TEXT } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import type { Conversation } from "./conversation.js";

const log = getLogger("conversation-interrupt-repair");

/**
 * Give every abandoned `tool_use` block at the tail of the history a
 * `tool_result`, so the next provider request is well formed.
 *
 * An abort that lands mid-tool leaves the history ending on an assistant
 * message whose `tool_use` blocks have no matching result, which LLM providers
 * reject. The agent loop writes its own synthetic results when it unwinds
 * through its abort handler; this is the backstop for the aborts that never
 * reach it (the abort watchdog force-unwinding a wedged turn, a processing
 * flag force-cleared with no live turn behind it).
 *
 * The repaired row is persisted, not just pushed onto the in-memory history:
 * the interrupted turn's dangling `tool_use` blocks are already durable, so a
 * repair that lived only in memory would leave the next reload of this
 * conversation with the same broken tail this call just fixed.
 *
 * `force` is how the interrupt path asks for the repair unconditionally. The
 * legacy queue path arms `pendingSteerRepair` / `pendingInterruptRepair`
 * instead and repairs on the drain that follows.
 */
export async function repairInterruptedToolUseBlocks(
  conversation: Conversation,
  options: { force?: boolean } = {},
): Promise<void> {
  const armed =
    conversation.pendingSteerRepair || conversation.pendingInterruptRepair;
  if (!armed && options.force !== true) {
    return;
  }
  conversation.pendingSteerRepair = false;
  conversation.pendingInterruptRepair = false;

  const messages = conversation.messages;
  if (messages.length === 0) {
    return;
  }

  // Walk backwards from the tail to find the last assistant message with
  // tool_use blocks. Collect resolved IDs from any user messages between
  // the tail and that assistant message, then subtract them.
  const resolvedToolUseIds = new Set<string>();
  const pendingToolUseIds: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      for (const block of msg.content) {
        if (
          block.type === "tool_result" ||
          block.type === "web_search_tool_result"
        ) {
          resolvedToolUseIds.add(block.tool_use_id);
        }
      }
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool_use" && !resolvedToolUseIds.has(block.id)) {
          pendingToolUseIds.push(block.id);
        }
      }
      // Only repair tool_use blocks from the last assistant message that
      // has them — earlier history should already be consistent.
      break;
    }
  }

  if (pendingToolUseIds.length === 0) {
    return;
  }

  log.info(
    {
      conversationId: conversation.conversationId,
      pendingToolUseCount: pendingToolUseIds.length,
      forced: options.force === true,
    },
    "Injecting synthetic tool_result for pending tool_use blocks",
  );

  // Build a single user message with tool_result blocks for all pending IDs.
  const syntheticContent = pendingToolUseIds.map((toolUseId) => ({
    type: "tool_result" as const,
    tool_use_id: toolUseId,
    content: PREEMPTED_TOOL_RESULT_TEXT,
    is_error: true,
  }));
  conversation.messages.push({
    role: "user",
    content: syntheticContent,
  });
  try {
    await addMessage(
      conversation.conversationId,
      "user",
      JSON.stringify(syntheticContent),
      // A machine-written repair marker, not something to retrieve later.
      { skipIndexing: true },
    );
  } catch (err) {
    log.warn(
      { err, conversationId: conversation.conversationId },
      "Failed to persist the synthetic tool_result repair row; the in-memory history is repaired and the next reload repairs it again",
    );
  }
}
