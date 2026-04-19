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

// TODO(slack-thread-ctx PR 1): replace this local type with an import from
// `./message-metadata.js` once PR 1 lands. The shape is duplicated here so
// PR 6 can compile in isolation; both files agree on the schema.
type SlackEventKind = "message" | "reaction";

interface SlackMessageMetadata {
  readonly source: "slack";
  readonly channelId: string;
  readonly channelTs: string;
  readonly threadTs?: string;
  readonly displayName?: string;
  readonly eventKind: SlackEventKind;
  readonly reaction?: {
    readonly emoji: string;
    readonly actorDisplayName?: string;
    readonly targetChannelTs: string;
    readonly op: "added" | "removed";
  };
  readonly editedAt?: number;
  readonly deletedAt?: number;
}

export interface RenderableSlackMessage {
  role: "user" | "assistant";
  content: string;
  /** `null` indicates a legacy pre-upgrade row stored without Slack metadata. */
  metadata: SlackMessageMetadata | null;
  /** Display name or fallback (e.g. "@alice" or "@U12345"). */
  senderLabel: string;
  /** Fallback sort key for legacy rows; ignored when metadata.channelTs is set. */
  createdAt: number;
}

export interface RenderOptions {
  /** Reserved for future relative-time rendering; currently unused. */
  now?: Date;
  /** Cap rendered reactions per parent message; default 5. */
  maxReactionsPerMessage?: number;
}

interface RenderedMessage {
  role: "user" | "assistant";
  content: string;
}

const DEFAULT_MAX_REACTIONS = 5;

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
 * Format a Slack ts (`"1700000000.000100"`) as `HH:MM` (UTC).
 *
 * Slack ts is `<unix-seconds>.<microseconds>`; we treat it as a unix epoch
 * second value for display purposes. Pure — derives only from the ts string.
 */
function formatSlackTs(channelTs: string): string {
  const seconds = Number.parseFloat(channelTs);
  if (!Number.isFinite(seconds)) return "??:??";
  return formatEpochMs(seconds * 1000);
}

/**
 * Format an epoch millisecond timestamp as `HH:MM` (UTC).
 */
function formatEpochMs(ms: number): string {
  if (!Number.isFinite(ms)) return "??:??";
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
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
  if (!meta) {
    // Legacy pre-upgrade row: flat render, no thread tag.
    const time = formatEpochMs(msg.createdAt);
    return `[${time} ${msg.senderLabel}]: ${msg.content}`;
  }

  const time = formatSlackTs(meta.channelTs);

  if (meta.deletedAt !== undefined) {
    const dtime = formatEpochMs(meta.deletedAt);
    return `[${time} ${msg.senderLabel} — deleted ${dtime}]`;
  }

  let head = `[${time} ${msg.senderLabel}`;
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
 * `[14:28 @bob reacted 👍 to M1a2b3c]` or
 * `[14:28 @bob removed 👍 from M1a2b3c]`.
 */
function renderReaction(msg: RenderableSlackMessage): string | null {
  const meta = msg.metadata;
  if (!meta || meta.eventKind !== "reaction" || !meta.reaction) return null;
  const time = formatSlackTs(meta.channelTs);
  const verb = meta.reaction.op === "added" ? "reacted" : "removed";
  const prep = meta.reaction.op === "added" ? "to" : "from";
  const target = parentAlias(meta.reaction.targetChannelTs);
  return `[${time} ${msg.senderLabel} ${verb} ${meta.reaction.emoji} ${prep} ${target}]`;
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
): RenderedMessage[] {
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

  const out: RenderedMessage[] = [];
  for (const m of sorted) {
    const meta = m.metadata;
    if (meta?.eventKind === "reaction" && meta.reaction) {
      const target = meta.reaction.targetChannelTs;
      const seen = reactionCount.get(target) ?? 0;
      if (seen < maxReactions) {
        reactionCount.set(target, seen + 1);
        const line = renderReaction(m);
        if (line !== null) out.push({ role: m.role, content: line });
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
    out.push({ role: m.role, content: renderMessage(m) });
  }

  for (const [target, acc] of overflowAccumulator) {
    out.push({
      role: acc.role,
      content: `[…and ${acc.excess} more reactions to ${parentAlias(target)}]`,
    });
  }

  return out;
}
