import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ContentBlock,
  Message,
  ToolResultContent,
} from "../providers/types.js";
import {
  buildToolNameById,
  buildTruncatedContent,
  getToolResultFilePath,
  THRESHOLD_CHARS,
  TOOL_RESULT_DIR,
  TRUNCATION_EXEMPT_TOOLS,
  TRUNCATION_MARKER,
} from "./post-turn-tool-result-truncation.js";

/**
 * AX-tree snapshots have their own dedicated history compactor
 * (`compactAxTreeHistory`) with placeholder semantics tuned for computer-use
 * sessions, so the spool/stub pipeline leaves them alone.
 */
const AX_TREE_TAG = "<ax-tree>";

/**
 * Whether a tool result is eligible for the spool/stub pipeline. Mirrors the
 * skip rules of `postTurnTruncateToolResults` (size threshold, error results,
 * exempt tools, already-truncated marker) plus the AX-tree exemption.
 */
function isSpoolEligible(
  tr: ToolResultContent,
  toolName: string | undefined,
): boolean {
  if (typeof tr.content !== "string") return false;
  if (tr.content.length <= THRESHOLD_CHARS) return false;
  if (tr.is_error) return false;
  if (toolName !== undefined && TRUNCATION_EXEMPT_TOOLS.has(toolName)) {
    return false;
  }
  if (tr.content.includes(TRUNCATION_MARKER)) return false;
  if (tr.content.includes(AX_TREE_TAG)) return false;
  return true;
}

/**
 * Write every oversized tool result in `blocks` to its deterministic
 * `.tool-results/` file immediately — at result time, not turn end.
 *
 * This makes the full content available on disk while the turn is still
 * running, so (a) the model can read it back with file tools within the same
 * turn, and (b) `stubStaleOversizedToolResults` can swap the inline copy for
 * a stub on subsequent provider calls. The blocks themselves are not
 * modified; the durable history keeps the full content until
 * `postTurnTruncateToolResults` stubs it at turn end.
 *
 * Uses the same file paths and eligibility rules as the post-turn pass, so
 * both passes converge on identical files. Throws on filesystem errors —
 * callers treat the batch as non-fatal and skip it (the post-turn pass
 * self-heals any results missed here).
 *
 * Returns the number of results spooled.
 */
export function spoolOversizedToolResults(
  blocks: ContentBlock[],
  options: {
    conversationDir: string;
    toolNameById: (toolUseId: string) => string | undefined;
  },
): number {
  let spooledCount = 0;
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    const tr = block as ToolResultContent;
    if (!isSpoolEligible(tr, options.toolNameById(tr.tool_use_id))) continue;

    if (spooledCount === 0) {
      mkdirSync(join(options.conversationDir, TOOL_RESULT_DIR), {
        recursive: true,
      });
    }
    writeFileSync(
      getToolResultFilePath(options.conversationDir, tr.tool_use_id),
      tr.content,
      "utf-8",
    );
    spooledCount++;
  }
  return spooledCount;
}

/**
 * Replace stale oversized tool results with the same prefix/suffix stub the
 * post-turn pass produces, so the full content is sent to the provider only
 * once — on the call where the model receives it — instead of on every loop
 * iteration until the turn ends.
 *
 * "Stale" means any tool_result outside the most recent tool-result-bearing
 * user message (the same recency rule as the loop's media stripping): the
 * most recent batch is the one the model has not consumed yet, so it stays
 * intact. A result is only stubbed when its spooled file already exists on
 * disk — results that were never spooled (e.g. history reloaded after a
 * daemon restart) keep their full content rather than gaining a dangling
 * file pointer, and the post-turn pass stubs them durably at turn end.
 *
 * Pure projection: returns a shallow-copied messages array (only modified
 * messages are cloned) and never mutates the durable history.
 */
export function stubStaleOversizedToolResults(
  messages: Message[],
  conversationDir: string,
): { messages: Message[]; stubbedCount: number } {
  let lastToolResultUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (
      messages[i].role === "user" &&
      messages[i].content.some((b) => b.type === "tool_result")
    ) {
      lastToolResultUserIdx = i;
      break;
    }
  }
  if (lastToolResultUserIdx === -1) {
    return { messages, stubbedCount: 0 };
  }

  const toolNameById = buildToolNameById(messages);
  let stubbedCount = 0;

  const mapped = messages.map((msg, idx) => {
    if (idx >= lastToolResultUserIdx || msg.role !== "user") return msg;

    let changed = false;
    const nextContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;
      const tr = block as ToolResultContent;
      if (!isSpoolEligible(tr, toolNameById.get(tr.tool_use_id))) return block;

      const filePath = getToolResultFilePath(conversationDir, tr.tool_use_id);
      if (!existsSync(filePath)) return block;

      changed = true;
      stubbedCount++;
      return {
        ...tr,
        content: buildTruncatedContent(tr.content, filePath),
      } as ContentBlock;
    });

    return changed ? { ...msg, content: nextContent } : msg;
  });

  return { messages: stubbedCount > 0 ? mapped : messages, stubbedCount };
}
