/**
 * Pure chronological thread-tag rendering for Slack transcripts.
 *
 * Given a list of stored messages (post-upgrade rows with structured metadata
 * AND legacy pre-upgrade rows with `metadata === null`), produces a flat
 * `{role, content}[]` chronologically ordered with compact thread tags so
 * the model can reason across sibling threads in one channel.
 *
 * The function is pure: no I/O, no implicit clock reads. Time is taken from
 * `opts.now` only when needed for relative formatting. Sort and tag rendering
 * are deterministic.
 *
 * Wiring lands in PR 17 (inbound history rendering) and PR 21 (compaction
 * boundary).
 */

import { createHash } from "node:crypto";

import type { ContentBlock, Message } from "../../../providers/types.js";
import type { SlackMessageMetadata } from "./message-metadata.js";

export interface RenderableSlackMessage {
  role: "user" | "assistant";
  content: string;
  /** `null` indicates a legacy pre-upgrade row stored without Slack metadata. */
  metadata: SlackMessageMetadata | null;
  /**
   * Sender display name to prepend to the tag line (e.g. `"@alice"`), or
   * `null` to omit the label entirely. Callers should pass `null` when the
   * label would be redundant with the `role` slot — i.e. assistant rows and
   * user rows with no real Slack displayName. Reaction rows always need a
   * subject, so they receive a role-derived fallback if `null` is passed.
   */
  senderLabel: string | null;
  /** Fallback sort key for legacy rows; ignored when metadata.channelTs is set. */
  createdAt: number;
  /**
   * Full structured content blocks parsed from the persisted row, when
   * available. Optional so existing fixtures and callers that only need the
   * flattened `content` string continue to compile. The current
   * `renderSlackTranscript` implementation ignores this field — it exists so
   * downstream consumers (tool-block preservation) can access the original
   * `tool_use` / `tool_result` blocks without re-parsing the row.
   */
  readonly contentBlocks?: readonly ContentBlock[];
}

export interface RenderOptions {
  /** Reserved for future relative-time rendering; currently unused. */
  now?: Date;
  /** Cap rendered reactions per parent message; default 5. */
  maxReactionsPerMessage?: number;
}

const DEFAULT_MAX_REACTIONS = 5;

/**
 * Replayable Anthropic content-block types that we preserve verbatim from a
 * persisted row when rendering the Slack chronological transcript.
 *
 * `text` is intentionally omitted — text content is subsumed into the tag
 * line (e.g. `[11/14/23 14:25 @alice]: ...`) so callers reading the
 * rendered output see one human-readable line per row rather than a raw
 * text block stripped of thread context.
 *
 * Non-replayable types (`ui_surface`, `server_tool_use`,
 * `web_search_tool_result`, unknown types) are dropped: `ui_surface` blocks
 * are the assistant's ephemeral local UI scaffolding and not meaningful to
 * replay; `server_tool_use` / `web_search_tool_result` carry provider-
 * specific `encrypted_content` that becomes stale and is rejected by the
 * provider on re-send.
 */
const REPLAYABLE_BLOCK_TYPES = new Set<ContentBlock["type"]>([
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "image",
  "file",
]);

/**
 * Compute a short, stable, deterministic alias for a Slack message ts.
 *
 * Used as the "parent label" inside thread-reply tags so the model can
 * cross-reference children with their parent without leaking raw ts values.
 * First 6 hex chars of sha256(channelTs) prefixed with `M`.
 */
export function parentAlias(channelTs: string): string {
  const hash = createHash("sha256").update(channelTs).digest("hex");
  return `M${hash.slice(0, 6)}`;
}

/**
 * Format a Slack ts (`"1700000000.000100"`) as `MM/DD/YY HH:MM` (UTC).
 *
 * Slack ts is `<unix-seconds>.<microseconds>`; we treat it as a unix epoch
 * second value for display purposes. Pure — derives only from the ts string.
 */
function formatSlackTs(channelTs: string): string {
  const seconds = Number.parseFloat(channelTs);
  if (!Number.isFinite(seconds)) return "??/??/?? ??:??";
  return formatEpochMs(seconds * 1000);
}

/**
 * Format an epoch millisecond timestamp as `MM/DD/YY HH:MM` (UTC).
 */
function formatEpochMs(ms: number): string {
  if (!Number.isFinite(ms)) return "??/??/?? ??:??";
  const d = new Date(ms);
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mo}/${da}/${yy} ${hh}:${mm}`;
}

/**
 * Sort key for chronological ordering.
 *
 * Post-upgrade rows are ordered by their Slack `channelTs`; legacy rows
 * (metadata === null) fall back to `createdAt`. Both produce a numeric
 * seconds-since-epoch value so they intermix correctly.
 */
function sortKey(msg: RenderableSlackMessage): number {
  if (msg.metadata) {
    const n = Number.parseFloat(msg.metadata.channelTs);
    if (Number.isFinite(n)) return n;
  }
  // createdAt is epoch ms; convert to seconds for like-with-like comparison.
  return msg.createdAt / 1000;
}

/**
 * Render a single non-reaction message (post-upgrade or legacy) as one
 * tagged line.
 */
function renderMessage(msg: RenderableSlackMessage): string {
  const meta = msg.metadata;
  const senderPart = msg.senderLabel ? ` ${msg.senderLabel}` : "";
  if (!meta) {
    // Legacy pre-upgrade row: flat render, no thread tag.
    const time = formatEpochMs(msg.createdAt);
    return `[${time}${senderPart}]: ${msg.content}`;
  }

  const time = formatSlackTs(meta.channelTs);

  if (meta.deletedAt !== undefined) {
    const dtime = formatEpochMs(meta.deletedAt);
    return `[${time}${senderPart} — deleted ${dtime}]`;
  }

  let head = `[${time}${senderPart}`;
  if (meta.threadTs && meta.threadTs !== meta.channelTs) {
    head += ` → ${parentAlias(meta.threadTs)}`;
  }
  if (meta.editedAt !== undefined) {
    head += `, edited ${formatEpochMs(meta.editedAt)}`;
  }
  head += `]: ${msg.content}`;
  return head;
}

/**
 * Render a single reaction event as one tagged line.
 *
 * `[11/14/23 14:28 @bob reacted 👍 to M1a2b3c]` or
 * `[11/14/23 14:28 @bob removed 👍 from M1a2b3c]`.
 */
function renderReaction(msg: RenderableSlackMessage): string | null {
  const meta = msg.metadata;
  if (!meta || meta.eventKind !== "reaction" || !meta.reaction) return null;
  const time = formatSlackTs(meta.channelTs);
  const actor =
    msg.senderLabel ?? (msg.role === "assistant" ? "@assistant" : "@user");
  const verb = meta.reaction.op === "added" ? "reacted" : "removed";
  const prep = meta.reaction.op === "added" ? "to" : "from";
  const target = parentAlias(meta.reaction.targetChannelTs);
  return `[${time} ${actor} ${verb} ${meta.reaction.emoji} ${prep} ${target}]`;
}

/**
 * Build the content blocks for a single non-reaction message.
 *
 * Emits the tag line (`[MM/DD/YY HH:MM @sender ...]: body`) inline at the position of
 * the first `text` block in `contentBlocks`, and preserves any replayable
 * blocks (`tool_use`, `tool_result`, `thinking`, `redacted_thinking`,
 * `image`, `file`) in their original order. Non-replayable blocks
 * (`ui_surface`, `server_tool_use`, `web_search_tool_result`, unknown types)
 * are dropped.
 *
 * Special cases:
 * - **Deleted rows**: always emit a single tag-line block; replayable blocks
 *   (if any) are discarded because the delete is a logical erasure.
 * - **Legacy rows** (no structured `contentBlocks`, or empty array): fall
 *   back to a single tag-line block to preserve pre-plumbing behaviour.
 * - **Pure tool-only rows** (`contentBlocks` present but no `text` block):
 *   emit only the replayable blocks — no tag line. Anthropic accepts role-
 *   correct messages with only tool blocks.
 */
function buildMessageContentBlocks(
  msg: RenderableSlackMessage,
  tagLine: string,
): ContentBlock[] {
  const isDeleted = msg.metadata?.deletedAt !== undefined;
  const blocks = msg.contentBlocks;

  // Deleted rows: single tag line, drop any replayable content.
  if (isDeleted) {
    return [{ type: "text", text: tagLine }];
  }

  // Legacy / unplumbed rows: fall back to single tag line.
  if (!blocks || blocks.length === 0) {
    return [{ type: "text", text: tagLine }];
  }

  const out: ContentBlock[] = [];
  let tagEmitted = false;
  for (const block of blocks) {
    if (block.type === "text") {
      if (!tagEmitted) {
        out.push({ type: "text", text: tagLine });
        tagEmitted = true;
      }
      // Subsequent text blocks are already subsumed into the tag line.
      continue;
    }
    if (REPLAYABLE_BLOCK_TYPES.has(block.type)) {
      out.push(block);
      continue;
    }
    // Non-replayable (ui_surface, server_tool_use, web_search_tool_result,
    // unknown) — drop silently.
  }
  return out;
}

/**
 * Render a chronological transcript with compact thread tags.
 *
 * Sort is stable: messages with identical sort keys preserve their input
 * order so callers controlling input ordering can break ties deterministically.
 *
 * Reactions are rendered as their own lines (`[time @actor reacted ... to Mxxx]`),
 * but capped per-target at `opts.maxReactionsPerMessage` (default 5). Excess
 * reactions on the same target are collapsed into a single trailer line:
 * `[…and N more reactions to Mxxx]`.
 */
export function renderSlackTranscript(
  messages: RenderableSlackMessage[],
  opts?: RenderOptions,
): Message[] {
  if (messages.length === 0) return [];

  const maxReactions = Math.max(
    1,
    Math.floor(opts?.maxReactionsPerMessage ?? DEFAULT_MAX_REACTIONS),
  );

  // Stable sort: decorate-sort-undecorate so equal keys preserve input order.
  const indexed = messages.map((m, i) => ({ m, i, k: sortKey(m) }));
  indexed.sort((a, b) => {
    if (a.k !== b.k) return a.k - b.k;
    return a.i - b.i;
  });
  const sorted = indexed.map((x) => x.m);

  // Per-target reaction counters used to enforce the cap.
  const reactionCount = new Map<string, number>();
  // Accumulate excess reactions per target so we can emit one trailer line
  // each at the end. Map insertion order is the discovery order during the
  // chronological walk, which keeps trailer emission deterministic.
  const overflowAccumulator = new Map<
    string,
    { excess: number; role: "user" | "assistant" }
  >();

  const out: Message[] = [];
  for (const m of sorted) {
    const meta = m.metadata;
    if (meta?.eventKind === "reaction" && meta.reaction) {
      const target = meta.reaction.targetChannelTs;
      const seen = reactionCount.get(target) ?? 0;
      if (seen < maxReactions) {
        reactionCount.set(target, seen + 1);
        const line = renderReaction(m);
        if (line !== null) {
          out.push({
            role: m.role,
            content: [{ type: "text" as const, text: line }],
          });
        }
      } else {
        const acc = overflowAccumulator.get(target) ?? {
          excess: 0,
          role: m.role,
        };
        acc.excess += 1;
        overflowAccumulator.set(target, acc);
      }
      continue;
    }
    const tagLine = renderMessage(m);
    const blocks = buildMessageContentBlocks(m, tagLine);
    if (blocks.length === 0) continue;
    out.push({
      role: m.role,
      content: blocks,
    });
  }

  for (const [target, acc] of overflowAccumulator) {
    out.push({
      role: acc.role,
      content: [
        {
          type: "text" as const,
          text: `[…and ${acc.excess} more reactions to ${parentAlias(target)}]`,
        },
      ],
    });
  }

  return filterOrphanToolPairs(out);
}

/**
 * Final safety pass that drops unpaired tool-call blocks of either shape:
 * locally-executed (`tool_use` ↔ `tool_result`) and server-side web search
 * (`server_tool_use` ↔ `web_search_tool_result`).
 *
 * Anthropic's API requires every producing block in an assistant turn to be
 * matched by its consuming block in the following user turn (and vice versa).
 * In normal operation `renderSlackTranscript` emits fully-paired turns
 * because the persisted transcript reflects completed tool exchanges, but
 * edge cases (mid-turn compaction, partial failures, a race between
 * producer persistence and consumer persistence) can leave an orphan in
 * the rendered output. Sending an orphan to the provider hard-fails the
 * entire request, so we defensively prune any unpaired block here.
 *
 * A message that becomes empty after filtering (e.g. an assistant row that
 * carried only an orphaned `tool_use`) is dropped entirely rather than
 * emitted as `{role, content: []}` — empty-content messages are also
 * rejected by the provider.
 */
function filterOrphanToolPairs(messages: Message[]): Message[] {
  const produced = new Set<string>();
  const consumed = new Set<string>();
  for (const msg of messages) {
    for (const b of msg.content) {
      if (b.type === "tool_use" || b.type === "server_tool_use") {
        produced.add(b.id);
      } else if (
        b.type === "tool_result" ||
        b.type === "web_search_tool_result"
      ) {
        consumed.add(b.tool_use_id);
      }
    }
  }
  const out: Message[] = [];
  for (const msg of messages) {
    const kept: ContentBlock[] = [];
    for (const b of msg.content) {
      if (
        (b.type === "tool_use" || b.type === "server_tool_use") &&
        !consumed.has(b.id)
      ) {
        continue;
      }
      if (
        (b.type === "tool_result" || b.type === "web_search_tool_result") &&
        !produced.has(b.tool_use_id)
      ) {
        continue;
      }
      kept.push(b);
    }
    if (kept.length > 0) out.push({ role: msg.role, content: kept });
  }
  return out;
}

/**
 * Extract the first text-block text from each rendered message.
 *
 * Used by callers (e.g. the active-thread focus block) that need a flat
 * `string[]` of rendered tag lines rather than the structured `Message[]`
 * output. Messages with no text block yield an empty string.
 */
export function extractTagLineTexts(rendered: Message[]): string[] {
  return rendered.map((msg) => {
    const first = msg.content.find((b) => b.type === "text");
    return first && first.type === "text" ? first.text : "";
  });
}
