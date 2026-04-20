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
 * Consumers wire this into inbound history rendering and the compaction
 * boundary.
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
   * flattened `content` string continue to compile. `renderSlackTranscript`
   * consumes this field to preserve replayable Anthropic blocks
   * (`tool_use`, `tool_result`, `thinking`, `redacted_thinking`, `image`,
   * `file`) in their original order, emitting the tag line inline at the
   * position of the first `text` block. Non-replayable blocks
   * (`ui_surface`, `server_tool_use`, `web_search_tool_result`, unknown
   * types) are stripped; when stripping empties the row entirely, a
   * fallback tag-line text block is emitted so chronology is preserved.
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
 * - **All-non-replayable rows** (`contentBlocks` present but every block is
 *   filtered out — e.g. a row whose only blocks are `server_tool_use` or
 *   `ui_surface`): emit a single fallback tag-line text block annotated
 *   with the stripped block types/names. Dropping the row entirely would
 *   silently alter chronology and can orphan adjacent tool_result context
 *   in later repair/conversion steps.
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
  const strippedLabels: string[] = [];
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
    // unknown) — drop, but remember what we saw in case we need a fallback.
    if (block.type === "server_tool_use") {
      strippedLabels.push(`server_tool_use(${block.name})`);
    } else {
      strippedLabels.push(block.type);
    }
  }

  // Non-empty source fully filtered to nothing: emit a fallback tag line so
  // the turn still appears in chronology. Annotate with the stripped block
  // types/names so the model has a hint about what was there.
  if (out.length === 0) {
    const suffix =
      strippedLabels.length > 0
        ? ` [stripped non-replayable: ${strippedLabels.join(", ")}]`
        : "";
    return [{ type: "text", text: `${tagLine}${suffix}` }];
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
 * reactions on the same target are collapsed into a single trailer line
 * (`[…and N more reactions to Mxxx]`, singular `reaction` when N===1), emitted
 * at the point the overflow window closes — i.e. immediately before the next
 * event that is not an overflowing reaction for the same target — so trailers
 * stay in chronological position instead of batching at the tail.
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
  // Open per-target overflow windows. Excess reactions accumulate here; the
  // window is closed (trailer emitted) as soon as the chronological walk
  // reaches an event that is not an overflowing reaction for that target.
  const overflowAccumulator = new Map<
    string,
    { excess: number; role: "user" | "assistant" }
  >();

  const trailerMessage = (
    target: string,
    acc: { excess: number; role: "user" | "assistant" },
  ): Message => ({
    role: acc.role,
    content: [
      {
        type: "text" as const,
        text: `[…and ${acc.excess} more ${acc.excess === 1 ? "reaction" : "reactions"} to ${parentAlias(target)}]`,
      },
    ],
  });

  const flushOverflowExcept = (out: Message[], keepTarget: string | null) => {
    for (const target of Array.from(overflowAccumulator.keys())) {
      if (target === keepTarget) continue;
      const acc = overflowAccumulator.get(target)!;
      out.push(trailerMessage(target, acc));
      overflowAccumulator.delete(target);
    }
  };

  const out: Message[] = [];
  for (const m of sorted) {
    const meta = m.metadata;
    if (meta?.eventKind === "reaction" && meta.reaction) {
      const target = meta.reaction.targetChannelTs;
      const seen = reactionCount.get(target) ?? 0;
      if (seen < maxReactions) {
        // Reaction fits under the cap for `target`. Any open overflow windows
        // for other targets are now behind us chronologically — close them.
        flushOverflowExcept(out, null);
        reactionCount.set(target, seen + 1);
        const line = renderReaction(m);
        if (line !== null) {
          out.push({
            role: m.role,
            content: [{ type: "text" as const, text: line }],
          });
        }
      } else {
        // Reaction overflows for `target`. Close any other open windows, then
        // extend this target's open window.
        flushOverflowExcept(out, target);
        const acc = overflowAccumulator.get(target) ?? {
          excess: 0,
          role: m.role,
        };
        acc.excess += 1;
        overflowAccumulator.set(target, acc);
      }
      continue;
    }
    // Non-reaction event: every open overflow window closes here.
    flushOverflowExcept(out, null);
    const tagLine = renderMessage(m);
    const blocks = buildMessageContentBlocks(m, tagLine);
    if (blocks.length === 0) continue;
    out.push({
      role: m.role,
      content: blocks,
    });
  }

  // End of the walk: flush any still-open overflow windows.
  flushOverflowExcept(out, null);

  return filterOrphanToolPairs(out);
}

/**
 * Final safety pass that drops unpaired `tool_use` ↔ `tool_result` blocks.
 *
 * Anthropic's API requires every `tool_use` in an assistant turn to be
 * matched by a `tool_result` in the following user turn (and vice versa).
 * In normal operation `renderSlackTranscript` emits fully-paired turns
 * because the persisted transcript reflects completed tool exchanges, but
 * edge cases (mid-turn compaction, partial failures, a race between
 * producer persistence and consumer persistence) can leave an orphan in
 * the rendered output. Sending an orphan to the provider hard-fails the
 * entire request, so we defensively prune any unpaired block here.
 *
 * Server-side block types (`server_tool_use`, `web_search_tool_result`) are
 * stripped earlier by `buildMessageContentBlocks` — they carry stale
 * provider-specific `encrypted_content` and are never replayed — so they
 * cannot reach this filter.
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
      if (b.type === "tool_use") produced.add(b.id);
      else if (b.type === "tool_result") consumed.add(b.tool_use_id);
    }
  }
  const out: Message[] = [];
  for (const msg of messages) {
    const kept: ContentBlock[] = [];
    for (const b of msg.content) {
      if (b.type === "tool_use" && !consumed.has(b.id)) continue;
      if (b.type === "tool_result" && !produced.has(b.tool_use_id)) continue;
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
