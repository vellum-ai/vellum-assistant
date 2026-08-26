/**
 * The sidecar's derivation layer: which conversations get a channel drawer,
 * and how one transcript splits into two lanes.
 *
 * Pure and React-free so both the drawer and the chat lane can re-derive from
 * the same transcript array without either owning the other. Nothing here is
 * channel-specific: every branch reads {@link ChannelMessageProvenance} or the
 * conversation's binding, both of which are neutral vocabularies.
 */

import {
  getBoundChannelId,
  readChannelMessageProvenance,
  type ChannelMessageProvenance,
  type ProvenanceConversation,
} from "@/domains/chat/channel-sidecar/channel-message-provenance";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { getChannelBindingDisplayText } from "@/domains/chat/utils/channel-conversation-display";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ChannelSidecarRef } from "@/stores/viewer-store";
import { getExternalLinkUrl } from "@/utils/external-source-link";

/** One row of the external-channel transcript, as the drawer renders it. */
export interface ChannelTranscriptEntry {
  /** Transcript row id, reused as the React key and the reference identity. */
  id: string;
  provenance: ChannelMessageProvenance;
  /**
   * The row's complete flat body text. The drawer is the canonical home of
   * the rows it holds, so nothing is cut here; the composer reference applies
   * its own snippet bound (see `toChannelReference`).
   */
  text: string;
  timestamp?: number;
  /** `user` rows read as the channel's participants, everything else as the assistant. */
  role: DisplayMessage["role"];
}

/** Everything the header control and the drawer need to describe the thread. */
export interface ChannelSidecarTarget extends ChannelSidecarRef {
  /**
   * The thread's own name when the binding or a row reports one (a Slack
   * channel name, a Telegram chat title, an email subject). Absent when the
   * channel reports only opaque ids, which are not worth showing a reader.
   */
  threadName?: string;
  /** Deep link into the source channel, when one is derivable. */
  sourceHref?: string;
}

/**
 * An entry's epoch-ms timestamp as an ISO-8601 string, or `undefined` when
 * the channel reported none. A non-finite value reads as none: consumers
 * render or encode the timestamp only when there is a real one.
 */
export function channelTimestampToIso(
  timestamp: number | undefined,
): string | undefined {
  if (timestamp == null || !Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}

/**
 * Whether the drawer's plain-text row is a lossless rendering of a message.
 *
 * The drawer draws sender, time, and body text. A row carrying anything else
 * a reader can see (attachments, or non-text content blocks such as tool
 * activity, thinking, or surfaces) would lose that content if it left the
 * Vellum lane, so the partition keeps such rows in the lane even when the
 * channel attributes them.
 */
function isLosslessAsPlainText(message: DisplayMessage): boolean {
  if (message.attachments && message.attachments.length > 0) {
    return false;
  }
  return (message.contentBlocks ?? []).every((block) => block.type === "text");
}

/**
 * Split one transcript into the Vellum lane and the external-channel lane.
 *
 * A row moves to the channel lane only when the client can attribute it (see
 * `readChannelMessageProvenance`) AND the drawer can render it losslessly
 * (see {@link isLosslessAsPlainText}). Every other row stays in the Vellum
 * lane, so the failure mode is a lane identical to the unpartitioned
 * transcript, never content that vanishes from both lanes.
 *
 * Returns the input array by reference when nothing moved, so the chat lane's
 * downstream memos see no change on conversations the sidecar does not touch.
 */
export function partitionChannelTranscript({
  messages,
  conversation,
}: {
  messages: DisplayMessage[];
  conversation: ProvenanceConversation | null | undefined;
}): {
  vellumMessages: DisplayMessage[];
  entries: ChannelTranscriptEntry[];
} {
  const channelId = getBoundChannelId(conversation);
  if (!channelId) {
    return { vellumMessages: messages, entries: [] };
  }

  const vellumMessages: DisplayMessage[] = [];
  const entries: ChannelTranscriptEntry[] = [];
  for (const message of messages) {
    const provenance = readChannelMessageProvenance(message, conversation);
    if (!provenance || !isLosslessAsPlainText(message)) {
      vellumMessages.push(message);
      continue;
    }
    entries.push({
      id: message.id,
      provenance,
      text: messagePlainText(message).trim(),
      timestamp: message.timestamp,
      role: message.role,
    });
  }

  return {
    vellumMessages: entries.length === 0 ? messages : vellumMessages,
    entries,
  };
}

/**
 * Describe the thread a channel-bound conversation belongs to, or `null` when
 * the conversation is not channel-bound.
 *
 * Deliberately independent of whether any row could be attributed: a channel
 * that reports nothing per message still has an identity and, usually, a link
 * back to itself, and hiding the drawer from it would make the feature
 * Slack-shaped. Callers decide separately whether there is enough to show
 * (see {@link hasChannelSidecarContent}).
 */
export function resolveChannelSidecarTarget({
  conversationId,
  conversation,
  entries,
  sourceHref,
}: {
  conversationId: string | null | undefined;
  conversation: ProvenanceConversation | null | undefined;
  entries: ChannelTranscriptEntry[];
  /**
   * Richer link derived by the caller, used ahead of the binding's neutral
   * `sourceLink` when present. The header already computes one that folds in
   * message-level links and covers daemons that do not populate `sourceLink`.
   */
  sourceHref?: string | null;
}): ChannelSidecarTarget | null {
  const channelId = getBoundChannelId(conversation);
  if (!channelId || !conversationId) {
    return null;
  }
  const binding = conversation?.channelBinding;
  const target: ChannelSidecarTarget = { conversationId, channelId };

  const namedEntry = entries.find((entry) =>
    entry.provenance.externalChatName?.trim(),
  );
  const threadName =
    getChannelBindingDisplayText(binding) ??
    namedEntry?.provenance.externalChatName?.trim();
  if (threadName) {
    target.threadName = threadName;
  }

  // Thread altitude, best first: the caller's richer link, then the binding's
  // own, then the newest row's thread link, and only then a message link. The
  // last is a deliberate last resort. It lands the reader deeper into the
  // thread than they asked for, which still beats no way through at all.
  const newest = entries[entries.length - 1]?.provenance;
  const href =
    sourceHref?.trim() ||
    getExternalLinkUrl(binding?.sourceLink) ||
    getExternalLinkUrl(newest?.threadSourceLink) ||
    getExternalLinkUrl(newest?.sourceLink);
  if (href) {
    target.sourceHref = href;
  }
  return target;
}

/**
 * Whether a target has anything a reader would open the drawer for: rows to
 * read, or a way through to the source. A bound conversation with neither is
 * left alone, so the header keeps its source-link pill rather than offering
 * a control that opens an empty panel with no way out of it.
 */
export function hasChannelSidecarContent(
  target: ChannelSidecarTarget | null,
  entries: ChannelTranscriptEntry[],
): boolean {
  if (!target) {
    return false;
  }
  return entries.length > 0 || target.sourceHref != null;
}

/**
 * Whether a row is content a reader can stage as a composer reference.
 *
 * Reaction rows are channel activity about a message, not a message: a
 * reference built from one would carry no body and none of the reaction
 * fields (`ChannelReference` has no `kind`, emoji, op, or actor), so the
 * drawer renders reaction rows read-only, with no reference control.
 */
export function isReferenceableChannelEntry(
  entry: ChannelTranscriptEntry,
): boolean {
  return entry.provenance.kind === "message";
}
