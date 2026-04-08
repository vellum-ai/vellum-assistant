import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ContentBlock,
  Message,
  ToolResultContent,
} from "../providers/types.js";

/** Minimum content length (chars) before a tool result is eligible for truncation. ~2000 tokens at 4 chars/token. */
export const THRESHOLD_CHARS = 8_000;

/** Target size (chars) for the truncated stub. ~300 tokens at 4 chars/token. */
export const TARGET_CHARS = 1_200;

/** Subdirectory name under the conversation directory for saved full results. */
export const TOOL_RESULT_DIR = ".tool-results";

/** Marker used to detect already-truncated results (idempotency guard). */
export const TRUNCATION_MARKER = "\u2014 full result:";

/**
 * Deterministic file path for a tool result's full content on disk.
 * Uses the first 12 hex chars of the SHA-256 of the tool_use_id.
 */
export function getToolResultFilePath(
  conversationDir: string,
  toolUseId: string,
): string {
  const hash = createHash("sha256").update(toolUseId).digest("hex").slice(0, 12);
  return join(conversationDir, TOOL_RESULT_DIR, `${hash}.txt`);
}

/**
 * Build the truncated stub that replaces a large tool result in context.
 * Preserves the first and last halves of TARGET_CHARS, with a middle marker
 * indicating how many tokens were omitted and where to find the full result.
 */
export function buildTruncatedContent(
  original: string,
  filePath: string,
): string {
  const half = Math.floor(TARGET_CHARS / 2);
  const prefix = original.slice(0, half);
  const suffix = original.slice(-half);
  const omittedChars = original.length - TARGET_CHARS;
  const estimatedTokens = Math.round(omittedChars / 4);
  return `${prefix}\n\n...(${estimatedTokens} tokens omitted ${TRUNCATION_MARKER} ${filePath})\n\n${suffix}`;
}

/**
 * Walk all messages and truncate tool results that exceed `THRESHOLD_CHARS`.
 *
 * For each eligible result:
 * - The full content is persisted to a deterministic file path on disk.
 * - The in-context content is replaced with a prefix/suffix stub.
 *
 * Results are skipped if they are below threshold, are error results,
 * or have already been truncated (contain `TRUNCATION_MARKER`).
 *
 * Returns a shallow-copied messages array (only modified messages are cloned)
 * and the count of results that were truncated.
 */
export function postTurnTruncateToolResults(
  messages: Message[],
  options: { conversationDir: string },
): { messages: Message[]; truncatedCount: number } {
  let truncatedCount = 0;

  const mapped = messages.map((msg) => {
    let changed = false;
    const nextContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;
      const tr = block as ToolResultContent;

      // Skip short results.
      if (tr.content.length <= THRESHOLD_CHARS) return block;

      // Skip error results.
      if (tr.is_error) return block;

      // Skip already-truncated results (idempotency).
      if (tr.content.includes(TRUNCATION_MARKER)) return block;

      const filePath = getToolResultFilePath(
        options.conversationDir,
        tr.tool_use_id,
      );

      // Persist full content to disk.
      mkdirSync(join(options.conversationDir, TOOL_RESULT_DIR), {
        recursive: true,
      });
      writeFileSync(filePath, tr.content, "utf-8");

      changed = true;
      truncatedCount++;
      return {
        ...tr,
        content: buildTruncatedContent(tr.content, filePath),
      } as ContentBlock;
    });

    return changed ? { ...msg, content: nextContent } : msg;
  });

  return { messages: truncatedCount > 0 ? mapped : messages, truncatedCount };
}
