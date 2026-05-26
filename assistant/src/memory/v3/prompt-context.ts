/**
 * Memory v3 — shared LLM-prompt context block.
 *
 * Every v3 lane that makes a judgment call (the dense filter, the tree-walk
 * descent driver, the selection gate) must see the same situational context:
 * the standing NOW block plus the just-arrived turn being retrieved for. This
 * is the single source of that block so the lanes can't drift apart — a lane
 * that omits the turn judges relevance blind to what the user actually asked.
 */

import type { RetrievalInput } from "../v2/harness/retriever.js";

/**
 * Render the standing NOW context plus the just-arrived turn for a v3 lane's
 * LLM prompt. The just-arrived user turn is the last `recentTurnPairs` entry's
 * `userMessage`; the prior assistant reply (when present) precedes it. NOW is
 * passed verbatim. With no turn pairs the `<last_turn>` block is empty but
 * still emitted, so the prompt shape is stable.
 */
export function renderConversationContext(input: RetrievalInput): string {
  const lines: string[] = [];
  const lastPair = input.recentTurnPairs[input.recentTurnPairs.length - 1];
  if (lastPair) {
    if (lastPair.assistantMessage.trim().length > 0) {
      lines.push(`[assistant]: ${lastPair.assistantMessage}`);
    }
    lines.push(`[user]: ${lastPair.userMessage}`);
  }
  return (
    `<now>\n${input.nowText}\n</now>\n\n` +
    `<last_turn>\n${lines.join("\n")}\n</last_turn>`
  );
}
