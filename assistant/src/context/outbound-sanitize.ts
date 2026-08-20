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
 *
 * Deliberately narrower than `escapeTagBoundaries` in
 * `security/untrusted-content.ts`, which is the general defense for fencing
 * untrusted text: this one leaves the opening tag intact because
 * {@link AX_TREE_PATTERN} needs it to find whole blocks. Do not fold the two
 * together.
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
 * Full-wrapper matcher for the `<channel_capabilities>` block. Both ends are
 * required so a user message that merely opens with the tag (someone pasting
 * prompt markup into chat) is never mistaken for an injected block, the same
 * discipline `stripUserTextBlocksByPrefix` uses in `strip-injections.ts`.
 */
const CHANNEL_CAPABILITIES_OPEN = "<channel_capabilities>\n";
const CHANNEL_CAPABILITIES_CLOSE = "\n</channel_capabilities>";

/** Whether a text block is a complete `<channel_capabilities>…` block. */
function isChannelCapabilitiesBlock(text: string): boolean {
  return (
    text.startsWith(CHANNEL_CAPABILITIES_OPEN) &&
    text.endsWith(CHANNEL_CAPABILITIES_CLOSE)
  );
}

/**
 * Drop `<channel_capabilities>` blocks that repeat the last one still standing,
 * so a conversation carries one copy per distinct set of capabilities instead
 * of one per turn.
 *
 * Runtime injection prepends this block to the turn-starting user message and
 * then freezes it into history: live, because injection splices into the
 * conversation's own message array, and across restarts, because `loadFromDb`
 * rehydrates it from message metadata. Nothing ever removes it, so an N-turn
 * channel conversation ships N copies. Unlike `<turn_context>`, which at least
 * carries a fresh timestamp, this block is a pure function of the channel
 * (`buildChannelCapabilityBlock`): every copy after the first is byte-identical
 * to the one above it and tells the model nothing it has not already read.
 *
 * ## Why "same as the last retained copy" and not "not the current turn"
 *
 * Prompt caching only pays off when the bytes a provider marked in turn N are
 * still at the same position in turn N+1, an invariant this repo enforces end
 * to end in `prompt-cache-cross-turn-stability.test.ts`. Any rule of the form
 * "keep it on the current turn, collapse it above" necessarily re-renders one
 * message every turn (the turn that just ended), which is a full cache miss on
 * the whole message prefix, every turn, for every conversation.
 *
 * Comparing against the last RETAINED copy avoids that entirely: whether a
 * given occurrence survives depends only on the messages above it, never on
 * how many turns come later. A message's rendering is therefore fixed the
 * moment it is written, and the prefix stays byte-stable as the conversation
 * grows. Capabilities that genuinely change mid-conversation (the same
 * conversation resumed from a different client) still differ from the retained
 * copy, so the new block is kept and the model sees the change.
 *
 * The cost is placement: the surviving copy sits at the top of the conversation
 * rather than next to the newest message. It is the same bytes either way.
 *
 * Idempotent, like every other transform in this module: re-running it over an
 * already-deduplicated history retains exactly the same occurrences.
 */
export function dedupeChannelCapabilityBlocks(history: Message[]): Message[] {
  let lastRetained: string | null = null;
  let changed = false;

  const next = history.map((message) => {
    if (message.role !== "user") {
      return message;
    }

    let messageChanged = false;
    const content = message.content.filter((block) => {
      if (block.type !== "text" || !isChannelCapabilitiesBlock(block.text)) {
        return true;
      }
      if (block.text === lastRetained) {
        messageChanged = true;
        return false;
      }
      lastRetained = block.text;
      return true;
    });

    // A user row is never only injections in practice, but guard anyway: an
    // empty content array is not a message any provider will accept, and
    // dropping the row would break tool_use/tool_result pairing and the
    // row-to-history index mapping `summarizeUpToMessage` relies on.
    if (!messageChanged || content.length === 0) {
      return message;
    }
    changed = true;
    return { ...message, content };
  });

  return changed ? next : history;
}

/**
 * Index of the last user message carrying `tool_result` blocks — the
 * "current turn" boundary {@link stripOldMediaBlocks} keeps intact while
 * stripping media from older tool results. Returns -1 when no user message
 * has tool results.
 *
 * Targets the last user message with tool_results (not just the last user
 * message) because a plain-text user message may follow the tool-result turn;
 * using the last user message unconditionally would leave the most recent tool
 * screenshots unprotected from stripping.
 */
export function lastToolResultUserMessageIndex(history: Message[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (
      history[i].role === "user" &&
      history[i].content.some((b) => b.type === "tool_result")
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Strip image contentBlocks from all tool_result blocks except those in the
 * most recent user message that contains tool_result blocks. This prevents
 * screenshots from accumulating in the context window — each image is seen
 * once by the LLM on the turn it was captured, then replaced with a text
 * placeholder on subsequent turns.
 */
function stripOldMediaBlocks(history: Message[]): Message[] {
  const lastToolResultUserIdx = lastToolResultUserMessageIndex(history);

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
 * - {@link dedupeChannelCapabilityBlocks} keeps one `<channel_capabilities>`
 *   block per distinct set of capabilities instead of the one-per-turn history
 *   accumulates; every repeat is byte-identical to the copy above it.
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
  const webSearchStripped =
    stripHistoricalWebSearchResults(axCompacted).messages;
  return dedupeChannelCapabilityBlocks(webSearchStripped);
}
