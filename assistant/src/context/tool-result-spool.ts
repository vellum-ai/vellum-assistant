import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ContentBlock, ToolResultContent } from "../providers/types.js";
import {
  buildTruncatedContent,
  FILE_READ_TOOL_NAMES,
  getToolResultFilePath,
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
 * Whether a tool result is eligible for the result-time spool/stub pass: the
 * post-turn pass's shared rules plus the AX-tree exemption, minus the file-read
 * tools ({@link FILE_READ_TOOL_NAMES}). The file-read tools are the model's only
 * way to page spooled content back into context: stubbing a read of a
 * `.tool-results/` file would spool a fresh copy and hand back another stub, so
 * oversized content could never be read at all. Explicit reads are therefore
 * honored in full; the post-turn pass still truncates them at turn end, after
 * the model has consumed the content.
 */
function isSpoolEligible(
  tr: ToolResultContent,
  toolName: string | undefined,
): boolean {
  if (!isTruncationEligible(tr, toolName)) return false;
  if (toolName !== undefined && FILE_READ_TOOL_NAMES.has(toolName)) {
    return false;
  }
  if (tr.content.includes(AX_TREE_TAG)) return false;
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
 * `file_read` or `host_file_read` (whose results are exempt from this pass)
 * when it actually needs it.
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
    toolNameById: (toolUseId: string) => string | undefined;
  },
): number {
  let stubbedCount = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== "tool_result") continue;
    if (!isSpoolEligible(block, options.toolNameById(block.tool_use_id))) {
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
