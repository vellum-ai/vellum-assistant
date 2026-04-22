import type { ContentBlock, Message } from "../providers/types.js";

export interface StripThinkingStats {
  blocksStripped: number;
  messagesModified: number;
}

export interface StripThinkingResult {
  messages: Message[];
  stats: StripThinkingStats;
}

/**
 * Remove `thinking` and `redacted_thinking` blocks from every assistant
 * message EXCEPT the most recent one.
 *
 * Anthropic's API rejects requests whose prior assistant turns contain
 * thinking/redacted_thinking blocks that have been moved, rewritten, or
 * re-ordered relative to the original response (HTTP 400
 * "thinking blocks cannot be modified"). Stripping all historical thinking
 * blocks is the safest one-shot heal: the model does not need them to
 * continue the conversation, and the latest assistant turn is left intact
 * so that an in-progress tool chain's thinking signature still validates.
 */
export function stripHistoricalThinkingBlocks(
  messages: Message[],
): StripThinkingResult {
  const stats: StripThinkingStats = {
    blocksStripped: 0,
    messagesModified: 0,
  };

  // Find the index of the last assistant message; only older ones are stripped.
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  const next = messages.map((msg, idx) => {
    if (msg.role !== "assistant") return msg;
    if (idx === lastAssistantIndex) return msg;

    let stripped = 0;
    const rewritten: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        stripped++;
        continue;
      }
      rewritten.push(block);
    }

    if (stripped === 0) return msg;
    stats.blocksStripped += stripped;
    stats.messagesModified++;
    return { ...msg, content: rewritten };
  });

  return { messages: next, stats };
}
