/**
 * Outbound-request history sanitization shared by every provider call that
 * sends conversation history: the agent loop's model calls and the
 * compactor's summary calls. Each transform derives a sanitized projection of
 * the outbound copy only — durable history keeps the rich originals, and every
 * transform is idempotent so each send re-derives the same projection.
 */

import { stripHistoricalWebSearchResults } from "../daemon/web-search-history.js";
import type {
  ContentBlock,
  Message,
  ToolResultContent,
} from "../providers/types.js";

/** Number of most-recent AX tree snapshots to keep in conversation history. */
const MAX_AX_TREES_IN_HISTORY = 2;

/** Regex that matches the `<ax-tree>...</ax-tree>` markers. */
const AX_TREE_PATTERN = /<ax-tree>[\s\S]*?<\/ax-tree>/g;
const AX_TREE_PLACEHOLDER = "<ax_tree_omitted />";

/**
 * Escapes any literal `</ax-tree>` occurrences inside AX tree content so
 * that the non-greedy compaction regex (`AX_TREE_PATTERN`) does not stop
 * prematurely when the user happens to be viewing XML/HTML source that
 * contains the closing tag.  The escaped content does not need to be
 * unescaped because compaction replaces the entire block with a placeholder.
 */
export function escapeAxTreeContent(content: string): string {
  return content.replace(/<\/ax-tree>/gi, "&lt;/ax-tree&gt;");
}

/**
 * Returns a shallow copy of `messages` where all but the most recent
 * `MAX_AX_TREES_IN_HISTORY` `<ax-tree>` blocks have been replaced with a
 * short placeholder.  This keeps the conversation context small so that
 * TTFT does not grow linearly with step count in computer-use sessions.
 *
 * Counting is per-block, not per-message — a single user message can
 * contain multiple tool_result blocks each with their own AX tree snapshot.
 */
export function compactAxTreeHistory(messages: Message[]): Message[] {
  // Collect (messageIndex, blockIndex) for every tool_result block with <ax-tree>
  const axBlocks: Array<{ msgIdx: number; blockIdx: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") {
      continue;
    }
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (
        block.type === "tool_result" &&
        typeof block.content === "string" &&
        block.content.includes("<ax-tree>")
      ) {
        axBlocks.push({ msgIdx: i, blockIdx: j });
      }
    }
  }

  if (axBlocks.length <= MAX_AX_TREES_IN_HISTORY) {
    return messages;
  }

  // Build a set of "msgIdx:blockIdx" keys for blocks that should be stripped
  const toStrip = new Set(
    axBlocks
      .slice(0, -MAX_AX_TREES_IN_HISTORY)
      .map((b) => `${b.msgIdx}:${b.blockIdx}`),
  );

  return messages.map((msg, idx) => {
    // Quick check: does this message have any blocks to strip?
    const hasStripTarget = msg.content.some((_, j) =>
      toStrip.has(`${idx}:${j}`),
    );
    if (!hasStripTarget) {
      return msg;
    }

    return {
      ...msg,
      content: msg.content.map((block, j) => {
        if (
          toStrip.has(`${idx}:${j}`) &&
          block.type === "tool_result" &&
          typeof block.content === "string"
        ) {
          return {
            ...block,
            content: block.content.replace(
              AX_TREE_PATTERN,
              AX_TREE_PLACEHOLDER,
            ),
          };
        }
        return block;
      }),
    };
  });
}

/**
 * Strip image contentBlocks from all tool_result blocks except those in the
 * most recent user message that contains tool_result blocks. This prevents
 * screenshots from accumulating in the context window — each image is seen
 * once by the LLM on the turn it was captured, then replaced with a text
 * placeholder on subsequent turns.
 *
 * We target the last user message with tool_results (not just the last user
 * message) because a plain-text user message may follow the tool-result
 * turn. Using the last user message unconditionally would leave the most
 * recent tool screenshots unprotected from stripping.
 */
function stripOldMediaBlocks(history: Message[]): Message[] {
  // Find the last user message that contains tool_result blocks.
  let lastToolResultUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (
      history[i].role === "user" &&
      history[i].content.some((b) => b.type === "tool_result")
    ) {
      lastToolResultUserIdx = i;
      break;
    }
  }

  return history.map((msg, idx) => {
    // Keep the most recent tool-result user message intact (current turn)
    if (idx === lastToolResultUserIdx || msg.role !== "user") {
      return msg;
    }

    // Check if any tool_result blocks carry embedded media (image or audio).
    const isMedia = (cb: ContentBlock) =>
      cb.type === "image" || cb.type === "file";
    const hasMedia = msg.content.some(
      (b) =>
        b.type === "tool_result" &&
        (b as ToolResultContent).contentBlocks?.some(isMedia),
    );
    if (!hasMedia) {
      return msg;
    }

    // Strip media from tool_result blocks, replacing with a text marker. The
    // model already saw/heard the media in the turn it was captured; resending
    // the bytes every turn (a 12 MB audio clip isn't optimized like images)
    // bloats the request until compaction.
    return {
      ...msg,
      content: msg.content.map((b) => {
        if (b.type !== "tool_result") {
          return b;
        }
        const tr = b as ToolResultContent;
        if (!tr.contentBlocks?.some(isMedia)) {
          return b;
        }
        return {
          ...tr,
          contentBlocks: undefined,
          content:
            (tr.content || "") +
            "\n[Media (image/audio) was captured and shown previously — binary data removed to save context.]",
        };
      }),
    };
  });
}

/**
 * Sanitize the outbound history immediately before a provider call, bundling
 * the pre-send transforms applied to every request that carries conversation
 * history:
 * - {@link stripOldMediaBlocks} drops accumulated screenshot/audio bytes from
 *   older tool results — the model saw the media on the turn it was captured.
 *   Beyond context bloat, unstripped history can carry enough images to cross
 *   Anthropic's many-image threshold, where a stricter per-image dimension
 *   cap applies and a single large screenshot rejects the whole request.
 * - {@link compactAxTreeHistory} collapses all but the most recent few
 *   `<ax-tree>` snapshots so TTFT does not grow linearly with step count.
 * - {@link stripHistoricalWebSearchResults} converts historical
 *   `web_search_tool_result` blocks to text summaries; Anthropic's opaque
 *   `encrypted_content` tokens expire / are route-scoped, and replaying a stale
 *   one is rejected with `Invalid encrypted_content in search_result block`.
 *
 * Transforms the outbound copy only — the durable history keeps the rich
 * originals and each send re-derives the sanitized projection (every transform
 * is idempotent). Both the agent loop's model calls and the compactor's
 * summary calls funnel through this bundle, so their request prefixes stay
 * byte-aligned (the summary call reuses the agent's warm prompt cache) and
 * oversized media and expired web-search tokens are guaranteed to be removed
 * from every request.
 */
export function preModelCallSanitize(history: Message[]): Message[] {
  const mediaStripped = stripOldMediaBlocks(history);
  const axCompacted = compactAxTreeHistory(mediaStripped);
  return stripHistoricalWebSearchResults(axCompacted).messages;
}
