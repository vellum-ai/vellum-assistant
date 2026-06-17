/**
 * Lockstep helper for client-side tool-call state mutations.
 *
 * The transcript renders tool activity straight off the `tool_use` blocks in
 * `contentBlocks`, so any client-side change to a tool call's state
 * (confirmation attach/clear, risk stamping, dangling/stale repair,
 * force-complete) must patch the block copy too — otherwise the change never
 * reaches the screen. This mirrors the streaming-side `upsertToolUseBlock`
 * lockstep, applied to whole-message lifecycle/repair transforms.
 */

import type { ConversationContentBlock } from "@vellumai/assistant-api";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * Apply `transform` to every tool call on `message`, keeping the positional
 * `toolCalls` array and the matching `tool_use` blocks in `contentBlocks` in
 * lockstep. A `tool_use` block is matched to its transformed tool call by
 * `id`, the same key the streaming and ingest builders use.
 *
 * Returns the same `message` reference when no tool call changed, so callers
 * keep their existing identity-based change detection (`prev === next`).
 */
export function mapMessageToolCalls(
  message: DisplayMessage,
  transform: (toolCall: ChatMessageToolCall) => ChatMessageToolCall,
): DisplayMessage {
  if (!message.toolCalls?.length) {
    return message;
  }

  let changed = false;
  const patchedById = new Map<string, ChatMessageToolCall>();
  const toolCalls = message.toolCalls.map((tc) => {
    const next = transform(tc);
    if (next !== tc) {
      changed = true;
    }
    patchedById.set(next.id, next);
    return next;
  });

  if (!changed) {
    return message;
  }

  const contentBlocks = message.contentBlocks?.map(
    (block): ConversationContentBlock => {
      if (block.type !== "tool_use") {
        return block;
      }
      const id = block.toolCall.id;
      if (id === undefined) {
        return block;
      }
      const patched = patchedById.get(id);
      if (patched === undefined || patched === block.toolCall) {
        return block;
      }
      return { ...block, toolCall: patched };
    },
  );

  return { ...message, toolCalls, contentBlocks };
}
