// Content of the user message that answers a tool-calling assistant turn:
// the tool_result blocks plus any guidance a post-tool-use hook surfaced via
// `additionalContext`.

import { analyzeServerToolPairing } from "../providers/server-tool-pairing.js";
import type {
  ContentBlock,
  Message,
  TextContent,
  ToolResultContent,
} from "../providers/types.js";

/**
 * Hook guidance rides as separate blocks after the results, so the model sees
 * it while each tool_result stays the tool's actual output. The exception is
 * an assistant turn that left a server tool (native web search) deferred: the
 * provider runs a deferred server tool only when the answering message holds
 * tool_result blocks alone, and any block after the results closes the
 * assistant turn, after which the provider rejects the unanswered server tool
 * as unpaired. The guidance is then folded into the content of the last
 * errored tool_result (the last tool_result when none errored), where the
 * model still sees it and the search still runs.
 */
export function buildToolResultFollowUp(
  history: ReadonlyArray<Message>,
  resultBlocks: ContentBlock[],
  additionalContextBlocks: ReadonlyArray<TextContent>,
): ContentBlock[] {
  if (additionalContextBlocks.length === 0) {
    return resultBlocks;
  }
  const targetIndex = foldTargetIndex(resultBlocks);
  const pairing = analyzeServerToolPairing([
    ...history,
    { role: "user", content: resultBlocks },
  ]);
  if (pairing.deferredUseIds.size === 0 || targetIndex < 0) {
    return [...resultBlocks, ...additionalContextBlocks];
  }
  const target = resultBlocks[targetIndex] as ToolResultContent;
  const folded: ToolResultContent = {
    ...target,
    content: [target.content, ...additionalContextBlocks.map((b) => b.text)]
      .filter((text) => text.length > 0)
      .join("\n\n"),
  };
  return resultBlocks.map((block, index) =>
    index === targetIndex ? folded : block,
  );
}

/** Index of the last errored tool_result, else the last tool_result, else -1. */
function foldTargetIndex(blocks: ReadonlyArray<ContentBlock>): number {
  let lastResult = -1;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    // guard:allow-tool-result-only: the answering user message carries client
    // tool_result blocks only; server-side results live in assistant messages.
    if (block.type !== "tool_result") {
      continue;
    }
    if (block.is_error) {
      return index;
    }
    if (lastResult < 0) {
      lastResult = index;
    }
  }
  return lastResult;
}
