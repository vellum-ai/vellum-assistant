import type { ContentBlock, Message } from "./types.js";

/**
 * Strip trailing dangling `tool_use` blocks from a transcript before running a
 * nested inference call mid-turn.
 *
 * When a tool executor makes its own inference partway through a turn, the
 * transcript it inherits ends with the assistant message holding the in-flight
 * `tool_use` block(s) — the tool hasn't returned yet, so there is no matching
 * `tool_result`. Anthropic 400s on any `tool_use` without a paired result, so
 * those blocks must be removed before the nested call. `dropToolUseId` lets a
 * caller additionally drop a specific `tool_use` (e.g. the advisor tool's own
 * call) even when it does have a matching result.
 *
 * Pure: the input and its blocks are never mutated; modified messages are
 * cloned and a new array is returned.
 */
export function sanitizeTranscriptForNestedInference(
  messages: Message[],
  opts?: { dropToolUseId?: string },
): Message[] {
  const dropToolUseId = opts?.dropToolUseId;

  const matchedResultIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "tool_result") {
        matchedResultIds.add(block.tool_use_id);
      }
    }
  }

  const sanitized: Message[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      sanitized.push(message);
      continue;
    }

    const keptContent: ContentBlock[] = [];
    let droppedAny = false;
    for (const block of message.content) {
      if (block.type === "tool_use") {
        const isUnmatched = !matchedResultIds.has(block.id);
        const isExplicitlyDropped = block.id === dropToolUseId;
        if (isUnmatched || isExplicitlyDropped) {
          droppedAny = true;
          continue;
        }
      }
      keptContent.push(block);
    }

    if (!droppedAny) {
      sanitized.push(message);
      continue;
    }
    if (keptContent.length === 0) continue;
    sanitized.push({ role: message.role, content: keptContent });
  }

  return sanitized;
}
