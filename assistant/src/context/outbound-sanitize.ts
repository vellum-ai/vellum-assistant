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

/** Opening marker every AX tree snapshot is wrapped in. */
const AX_TREE_OPEN = "<ax-tree>";
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
 * The wrapper a watch session (`src/watch/watch-timeline.ts`) writes around
 * every timeline entry it persists, and the one thing in this module that
 * tells generated capture apart from what a user typed.
 *
 * A watch entry is an ordinary user message, so its blocks carry no shape a
 * `tool_result` does not also have. Without the marker the only available
 * signal is "user text containing `<ax-tree>`", which an ordinary conversation
 * about accessibility markup matches: the transforms below would rewrite the
 * user's own words and drop images the user attached themselves. Every
 * watch-only behavior here keys off this marker, and nothing unmarked changes.
 *
 * Both ends are required, the discipline {@link isChannelCapabilitiesBlock}
 * follows, so a message that merely opens with the tag is never taken for a
 * generated entry. The marker rides in the text because a `Message` carries no
 * metadata at the provider boundary: the persisted row's `watchSession` flag
 * does not reach this layer.
 */
const WATCH_ENTRY_OPEN = "<watch-entry>\n";
const WATCH_ENTRY_CLOSE = "\n</watch-entry>";

/**
 * Wrap one rendered timeline entry in the watch marker. The producer half of
 * the contract {@link WATCH_ENTRY_OPEN} documents.
 */
export function wrapWatchEntry(body: string): string {
  return `${WATCH_ENTRY_OPEN}${body}${WATCH_ENTRY_CLOSE}`;
}

/** Whether a text block is a complete marked watch timeline entry. */
function isWatchEntryText(text: string): boolean {
  return text.startsWith(WATCH_ENTRY_OPEN) && text.endsWith(WATCH_ENTRY_CLOSE);
}

/** Whether a message is a watch timeline entry. */
function isWatchEntryMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    message.content.some(
      (block) => block.type === "text" && isWatchEntryText(block.text),
    )
  );
}

/**
 * Whether a user content block carries an `<ax-tree>` snapshot.
 *
 * Two block shapes do. A computer-use step returns its tree in a
 * `tool_result`. A watch session writes each observation as a plain user
 * message and so carries its tree in a marked `text` block. It needs bounding
 * for the same reason and more urgently, since a session is minutes of
 * observations with no turn between them to compact.
 *
 * The marker is what makes the `text` arm safe: unmarked prose that mentions
 * `<ax-tree>` is somebody discussing the markup, not a snapshot of a screen.
 * Assistant messages stay out of scope either way.
 */
function hasAxTreeSnapshot(block: ContentBlock): boolean {
  if (block.type === "tool_result") {
    return (
      typeof block.content === "string" && block.content.includes(AX_TREE_OPEN)
    );
  }
  return (
    block.type === "text" &&
    isWatchEntryText(block.text) &&
    block.text.includes(AX_TREE_OPEN)
  );
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
  // Collect (messageIndex, blockIndex) for every user block with <ax-tree>
  const axBlocks: Array<{ msgIdx: number; blockIdx: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") {
      continue;
    }
    for (let j = 0; j < msg.content.length; j++) {
      if (hasAxTreeSnapshot(msg.content[j])) {
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
        if (!toStrip.has(`${idx}:${j}`)) {
          return block;
        }
        if (block.type === "tool_result" && typeof block.content === "string") {
          return {
            ...block,
            content: block.content.replace(
              AX_TREE_PATTERN,
              AX_TREE_PLACEHOLDER,
            ),
          };
        }
        if (block.type === "text") {
          return {
            ...block,
            text: block.text.replace(AX_TREE_PATTERN, AX_TREE_PLACEHOLDER),
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

/** Whether a content block carries media bytes (image or audio/file). */
function isMediaBlock(block: ContentBlock): boolean {
  return block.type === "image" || block.type === "file";
}

/** Stands in for media the model already saw on the turn it was captured. */
const MEDIA_STRIPPED_NOTE =
  "[Media (image/audio) was captured and shown previously, binary data removed to save context.]";

/**
 * Index of the last user message that is a watch timeline entry carrying
 * media, or -1 when there is none. The watch-side counterpart of
 * {@link lastToolResultUserMessageIndex}: the entry this points at keeps its
 * screenshot, every marked entry above it loses one.
 */
function lastWatchEntryMediaIndex(history: Message[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (
      isWatchEntryMessage(history[i]) &&
      history[i].content.some(isMediaBlock)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Replace the media blocks of a watch timeline entry with a text placeholder.
 * Unmarked messages and marked entries without media come back untouched.
 *
 * The placeholder takes the media block's own position rather than being
 * appended to the entry text, which keeps the marker's closing tag last and so
 * keeps the entry recognizable to every later pass over the same history.
 */
function stripWatchEntryMedia(message: Message): Message {
  if (!isWatchEntryMessage(message) || !message.content.some(isMediaBlock)) {
    return message;
  }
  return {
    ...message,
    content: message.content.map((block) =>
      isMediaBlock(block)
        ? { type: "text" as const, text: MEDIA_STRIPPED_NOTE }
        : block,
    ),
  };
}

/**
 * Strip media blocks from everywhere they accumulate: the `tool_result` blocks
 * of every user message but the most recent one carrying tool results, and the
 * watch timeline entries above the most recent entry carrying media. Each
 * image is seen once by the LLM on the turn it was captured, then replaced
 * with a text placeholder on subsequent turns.
 *
 * A watch session is the more urgent of the two. Its entries run no turn, so a
 * multi-minute session accumulates screenshots with nothing in between to
 * compact them, and the retrospective at the end reads the whole session at
 * once.
 *
 * Media on an unmarked user message is left alone: that is a file the user
 * attached, and dropping it would rewrite what they sent.
 */
function stripOldMediaBlocks(history: Message[]): Message[] {
  const lastToolResultUserIdx = lastToolResultUserMessageIndex(history);
  const lastWatchMediaIdx = lastWatchEntryMediaIndex(history);

  return history.map((msg, idx) => {
    if (msg.role !== "user") {
      return msg;
    }

    // Keep the most recent entry of each kind intact (the current turn).
    const watchStripped =
      idx === lastWatchMediaIdx ? msg : stripWatchEntryMedia(msg);
    if (idx === lastToolResultUserIdx) {
      return watchStripped;
    }

    // Check if any tool_result blocks carry embedded media (image or audio).
    const hasMedia = watchStripped.content.some(
      (b) =>
        b.type === "tool_result" &&
        (b as ToolResultContent).contentBlocks?.some(isMediaBlock),
    );
    if (!hasMedia) {
      return watchStripped;
    }

    // Strip media from tool_result blocks, replacing with a text marker. The
    // model already saw/heard the media in the turn it was captured; resending
    // the bytes every turn (a 12 MB audio clip isn't optimized like images)
    // bloats the request until compaction.
    return {
      ...watchStripped,
      content: watchStripped.content.map((b) => {
        if (b.type !== "tool_result") {
          return b;
        }
        const tr = b as ToolResultContent;
        if (!tr.contentBlocks?.some(isMediaBlock)) {
          return b;
        }
        return {
          ...tr,
          contentBlocks: undefined,
          content: `${tr.content || ""}\n${MEDIA_STRIPPED_NOTE}`,
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
 *   older tool results and older watch timeline entries: the model saw the
 *   media on the turn it was captured.
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
