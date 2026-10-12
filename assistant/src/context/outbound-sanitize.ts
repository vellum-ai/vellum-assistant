/**
 * Outbound-request history sanitization shared by every provider call that
 * sends conversation history: the agent loop's model calls and the
 * compactor's summary calls. Each transform derives a sanitized projection of
 * the outbound copy only (durable history keeps the rich originals), and every
 * transform is idempotent so each send re-derives the same projection.
 */

import { stripHistoricalWebSearchResults } from "../daemon/web-search-history.js";
import {
  type MediaPayloadLimits,
  mediaPayloadLimitsFor,
} from "../providers/media-payload-limits.js";
import {
  mediaSourceByteLength,
  mediaSourceDescriptor,
} from "../providers/media-resolve.js";
import type {
  ContentBlock,
  FileContent,
  ImageContent,
  MediaRetention,
  MediaSource,
  Message,
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
 * Index of the last user message carrying `tool_result` blocks: the current
 * tool step, the only place frame media survives. Returns -1 when no user
 * message has tool results.
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

type MediaBlock = ImageContent | FileContent;

function isMediaBlock(block: ContentBlock): block is MediaBlock {
  return block.type === "image" || block.type === "file";
}

/** Bytes a media block occupies in the request, which carries media as base64. */
function mediaWireBytes(source: MediaSource): number {
  return Math.ceil((mediaSourceByteLength(source) * 4) / 3);
}

export interface PreModelCallSanitizeOptions {
  /**
   * `Provider.name` of the transport the request goes to; selects the payload
   * marks retained media is held under. Omitted means the tightest known marks.
   */
  providerName?: string;
}

const FRAME_MEDIA_PLACEHOLDER =
  "\n[Media (image/audio) was captured and shown previously; binary data removed to save context.]";

function documentMediaPlaceholder(media: MediaBlock[]): string {
  const described = media
    .map((block) => mediaSourceDescriptor(block.source))
    .join("; ");
  return `\n[Media (${described}) shown in an earlier turn was removed from this request to stay within the provider's payload limit. Call the tool again to view it.]`;
}

/**
 * Decide which tool-result media the outbound copy keeps and which it drops.
 * Blocks are keyed `${messageIndex}:${blockIndex}`; an evicted block carries
 * the retention class that picks its replacement marker.
 *
 * Two retention classes, declared per tool (`mediaRetention` on the tool
 * definition) and stamped on the `tool_result` block by the agent loop:
 * - `frame` (the default): views of one evolving surface, such as
 *   screenshots. A newer frame supersedes older ones, so frames survive only
 *   in the current tool step ({@link lastToolResultUserMessageIndex}).
 * - `document`: distinct files the model may want side by side, such as file
 *   reads. Retained across steps and turns until the payload cap retires the
 *   oldest.
 *
 * The cap is a hysteresis band over the media the request carries: retained
 * documents plus the user's own attachments, which count toward the total but
 * are never evicted here (the reactive overflow path owns those). Walking the
 * history in order, once the running total crosses the high mark, whole
 * document-carrying messages are evicted oldest-first until the total is under
 * the low mark. A trip at message k evicts only messages before k, so whether
 * message j keeps its media depends only on the messages up to the trip that
 * evicted it, never on how the conversation continues: the projection of a
 * prefix is fixed once written, the prompt cache holds between trips, and the
 * agent loop and the compactor derive the same projection from the same
 * history with no shared state. Frames stay out of the running total for the
 * same reason: which frames go out depends on which step is current, which
 * changes every send.
 */
function planMediaRetention(
  history: Message[],
  limits: MediaPayloadLimits,
): { evicted: Map<string, MediaRetention>; retained: Set<string> } {
  const evicted = new Map<string, MediaRetention>();
  const retained = new Set<string>();
  const currentStepIdx = lastToolResultUserMessageIndex(history);
  const documentMessages: Array<{
    keys: string[];
    bytes: number;
    images: number;
  }> = [];
  let totalBytes = 0;
  let totalImages = 0;

  for (let msgIdx = 0; msgIdx < history.length; msgIdx++) {
    const msg = history[msgIdx];
    if (msg.role !== "user") {
      continue;
    }
    const documents = { keys: [] as string[], bytes: 0, images: 0 };
    for (let blockIdx = 0; blockIdx < msg.content.length; blockIdx++) {
      const block = msg.content[blockIdx];
      if (isMediaBlock(block)) {
        totalBytes += mediaWireBytes(block.source);
        totalImages += block.type === "image" ? 1 : 0;
        continue;
      }
      if (block.type !== "tool_result") {
        continue;
      }
      const media = block.contentBlocks?.filter(isMediaBlock) ?? [];
      if (media.length === 0) {
        continue;
      }
      const key = `${msgIdx}:${blockIdx}`;
      if ((block.mediaRetention ?? "frame") === "frame") {
        if (msgIdx === currentStepIdx) {
          retained.add(key);
        } else {
          evicted.set(key, "frame");
        }
        continue;
      }
      const bytes = media.reduce((n, b) => n + mediaWireBytes(b.source), 0);
      const images = media.filter((b) => b.type === "image").length;
      totalBytes += bytes;
      totalImages += images;
      retained.add(key);
      documents.keys.push(key);
      documents.bytes += bytes;
      documents.images += images;
    }

    if (totalBytes > limits.highBytes || totalImages > limits.highImages) {
      while (
        documentMessages.length > 0 &&
        (totalBytes > limits.lowBytes || totalImages > limits.lowImages)
      ) {
        const victim = documentMessages.shift()!;
        totalBytes -= victim.bytes;
        totalImages -= victim.images;
        for (const key of victim.keys) {
          retained.delete(key);
          evicted.set(key, "document");
        }
      }
    }
    if (documents.keys.length > 0) {
      documentMessages.push(documents);
    }
  }
  return { evicted, retained };
}

/**
 * Apply {@link planMediaRetention}: each evicted tool_result loses its media
 * blocks and gains a text marker saying what was dropped and, for a document,
 * how to get it back. The model saw the media on the step it was captured.
 */
function applyMediaRetention(
  history: Message[],
  limits: MediaPayloadLimits,
): Message[] {
  const { evicted: evictions } = planMediaRetention(history, limits);
  if (evictions.size === 0) {
    return history;
  }
  return history.map((msg, msgIdx) => {
    if (msg.role !== "user") {
      return msg;
    }
    let changed = false;
    const content = msg.content.map((block, blockIdx) => {
      const retention = evictions.get(`${msgIdx}:${blockIdx}`);
      if (retention === undefined || block.type !== "tool_result") {
        return block;
      }
      changed = true;
      const media = (block.contentBlocks ?? []).filter(isMediaBlock);
      return {
        ...block,
        contentBlocks: undefined,
        content:
          (block.content || "") +
          (retention === "frame"
            ? FRAME_MEDIA_PLACEHOLDER
            : documentMediaPlaceholder(media)),
      };
    });
    return changed ? { ...msg, content } : msg;
  });
}

/**
 * Keys (`${messageIndex}:${blockIndex}`) of the `tool_result` blocks whose
 * media {@link preModelCallSanitize} sends rather than replacing with a marker,
 * for consumers that mirror the outbound projection on the raw history (the
 * image-fallback plugin captions exactly the images a request carries).
 */
export function retainedToolResultMediaKeys(
  history: Message[],
  options: PreModelCallSanitizeOptions = {},
): Set<string> {
  return planMediaRetention(
    history,
    mediaPayloadLimitsFor(options.providerName),
  ).retained;
}

/**
 * Sanitize the outbound history immediately before a provider call, bundling
 * the pre-send transforms applied to every request that carries conversation
 * history:
 * - {@link applyMediaRetention} drops stale frame media (screenshots outside
 *   the current step) and, once the request's media crosses the provider's
 *   payload marks, the oldest document media (file reads), replacing each with
 *   a text marker. Beyond context bloat, an unbounded history can carry
 *   enough images to cross a provider's per-request limits, where a single
 *   request is rejected outright.
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
 * Transforms the outbound copy only: the durable history keeps the rich
 * originals and each send re-derives the sanitized projection (every transform
 * is idempotent). Both the agent loop's model calls and the compactor's
 * summary calls funnel through this bundle with the same `providerName`, so
 * their request prefixes stay byte-aligned (the summary call reuses the
 * agent's warm prompt cache) and over-cap media and expired web-search tokens
 * are guaranteed to be removed from every request.
 */
export function preModelCallSanitize(
  history: Message[],
  options: PreModelCallSanitizeOptions = {},
): Message[] {
  const mediaRetained = applyMediaRetention(
    history,
    mediaPayloadLimitsFor(options.providerName),
  );
  const axCompacted = compactAxTreeHistory(mediaRetained);
  const webSearchStripped =
    stripHistoricalWebSearchResults(axCompacted).messages;
  return dedupeChannelCapabilityBlocks(webSearchStripped);
}
