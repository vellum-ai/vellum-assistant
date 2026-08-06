import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ContentBlock, ToolResultContent } from "../providers/types.js";
import {
  buildTruncatedContent,
  getToolResultFilePath,
  isSpooledToolResultRead,
  isTruncationEligible,
  TOOL_RESULT_DIR,
} from "./post-turn-tool-result-truncation.js";

/**
 * AX-tree snapshots have their own dedicated history compactor
 * (`compactAxTreeHistory`) with placeholder semantics tuned for computer-use
 * sessions, and the model needs the freshest tree inline to act on it, so the
 * result-time pass leaves them alone.
 */
const AX_TREE_TAG = "<ax-tree>";

/**
 * Tools whose results are explicit, self-sized reads the model paginates
 * itself: `web_fetch` takes `max_chars`/`start_index` and reports a
 * "Character Window: X-Y of Z", so the model pages by character index against
 * the window it requested. Stubbing such a result at result time hands the
 * model ~a tenth of the window it just sized — and it keeps paging blind
 * against content it never saw. Like the file-read tools, these explicit
 * reads are honored in full for the turn that made them; the post-turn pass
 * still truncates them at turn end, after the model has consumed the content.
 */
export const RESULT_TIME_SPOOL_EXEMPT_TOOLS = new Set<string>(["web_fetch"]);

/**
 * Whether a tool result is eligible for the result-time spool/stub pass: the
 * post-turn pass's shared rules plus the AX-tree exemption, minus reads of
 * already-spooled `.tool-results/` files ({@link isSpooledToolResultRead}) and
 * the explicit self-sized reads ({@link RESULT_TIME_SPOOL_EXEMPT_TOOLS}).
 *
 * The spooled-read exemption is what keeps paging possible: a file read is the
 * model's only way to pull spooled content back into context, so stubbing a
 * read of a `.tool-results/` file would write a fresh copy and hand back
 * another stub, putting that content out of reach for good. It is scoped by
 * target path rather than by tool name, because a file read aimed anywhere
 * else is ordinary oversized output with no such circularity, and exempting it
 * keeps a whole file inline on every LLM call for the rest of the turn.
 * Explicit self-sized reads are honored in full; the post-turn pass still
 * truncates them at turn end, after the model has consumed the content.
 */
function isSpoolEligible(
  tr: ToolResultContent,
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): boolean {
  if (!isTruncationEligible(tr, toolName)) {
    return false;
  }
  if (isSpooledToolResultRead(toolName, toolInput)) {
    return false;
  }
  if (toolName !== undefined && RESULT_TIME_SPOOL_EXEMPT_TOOLS.has(toolName)) {
    return false;
  }
  if (tr.content.includes(AX_TREE_TAG)) {
    return false;
  }
  return true;
}

/**
 * Spool every oversized tool result in `blocks` to its deterministic
 * `.tool-results/` file and replace the inline content with the post-turn
 * pass's prefix/suffix stub — at result time, before the blocks join history.
 *
 * Because the swap happens before the content is ever sent, the
 * provider-bound history stays strictly append-only across the turn's model
 * calls, which is what keeps the provider's prompt-cache prefix valid:
 * rewriting an earlier message between calls would invalidate the cache from
 * that point on every iteration. The model still gets the head/tail preview
 * plus the on-disk path, so it can page the full content back in with
 * `file_read` or `host_file_read` (a read of a `.tool-results/` path is exempt
 * from this pass) when it actually needs it.
 *
 * Uses the same file paths, stub bytes, and eligibility rules as
 * `postTurnTruncateToolResults`, whose `TRUNCATION_MARKER` guard then skips
 * these results at turn end. Eligible elements of `blocks` are replaced in
 * place (the block objects themselves are not mutated). A result is only
 * stubbed after its file is written, so a stub never points at a missing
 * file; on filesystem errors the remaining blocks keep their full content and
 * the post-turn pass covers them.
 *
 * Returns the number of results spooled and stubbed.
 */
export function spoolAndStubOversizedToolResults(
  blocks: ContentBlock[],
  options: {
    conversationDir: string;
    /**
     * The originating call for a `tool_use_id`. A `tool_result` carries only
     * the id, and eligibility turns on both the tool's name and the path it
     * was pointed at, so the two travel together rather than as separate
     * lookups that could disagree.
     */
    toolCallById: (
      toolUseId: string,
    ) => { name: string; input: Record<string, unknown> } | undefined;
  },
): number {
  let stubbedCount = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== "tool_result") {
      continue;
    }
    const toolCall = options.toolCallById(block.tool_use_id);
    if (!isSpoolEligible(block, toolCall?.name, toolCall?.input)) {
      continue;
    }

    if (stubbedCount === 0) {
      mkdirSync(join(options.conversationDir, TOOL_RESULT_DIR), {
        recursive: true,
      });
    }
    const filePath = getToolResultFilePath(
      options.conversationDir,
      block.tool_use_id,
    );
    writeFileSync(filePath, block.content, "utf-8");
    blocks[i] = {
      ...block,
      content: buildTruncatedContent(block.content, filePath),
    };
    stubbedCount++;
  }
  return stubbedCount;
}
