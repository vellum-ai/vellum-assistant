/**
 * Every attachment a conversation carries: rows newest first, and the
 * attachments within one row in the order they were sent.
 *
 * Read from the transcript rows that carry attachments, which is the loaded
 * pages only, so `totalFiles` counts what is loaded rather than what the
 * conversation holds. Subscribing to those rows alone rather than to the whole
 * transcript keeps the always-mounted header trigger still while a turn
 * streams: older rows keep their identity and the streaming assistant row
 * carries nothing, so the selected set stays shallow-equal. Selecting the
 * snapshot's `messages` reference instead would cost less per store write and
 * re-render this hook on every token batch, which is the per-commit traffic
 * `docs/CONVENTIONS.md` keeps out of a streaming conversation.
 * The transcript also cannot see the camera-frame tag: that lives in daemon
 * message metadata which never crosses the message wire, so `sightFrame` is
 * always false and `totalFrames` is always 0 on this source.
 */

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  type ChatSessionStore,
  useChatSessionStore,
} from "@/domains/chat/chat-session-store";
import { selectTranscriptMessages } from "@/domains/chat/transcript/select-transcript-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { DisplayAttachment } from "@/types/attachment-types";

export interface ConversationAttachmentEntry {
  /**
   * Unique within the conversation. The attachment id, except for a legacy row
   * without structured metadata, whose `rehydrated:N` ids restart per row and
   * can repeat inside one row once adjacent assistant rows are folded, so
   * those are keyed by row and position instead.
   */
  key: string;
  attachment: DisplayAttachment;
  /** The carrying row's timestamp, epoch ms; null when the row carries none. */
  capturedAt: number | null;
  /** Captured by the live-vision camera gate. Always false on the transcript path. */
  sightFrame: boolean;
}

export interface ConversationAttachments {
  entries: ConversationAttachmentEntry[];
  /** Exact on the daemon path; the entry counts on the transcript path. */
  totalFiles: number;
  totalFrames: number;
  /**
   * Whether the target's own transcript has stopped loading: its chat session
   * owns it, and either a snapshot is loaded or the history fetch is over.
   * Empty entries mean "no files" only once this is true, and a history load
   * that failed settles here rather than staying unready for good.
   */
  transcriptSettled: boolean;
  hasMoreFiles: boolean;
  hasMoreFrames: boolean;
  loadMoreFiles: () => void;
  loadMoreFrames: () => void;
  source: "daemon" | "transcript";
}

/** Stable empty result, so a conversation with nothing stays referentially stable. */
const NO_ENTRIES: ConversationAttachmentEntry[] = [];

const NOOP = () => {};

function entryKey(
  messageId: string,
  attachmentId: string,
  position: number,
): string {
  return attachmentId.startsWith("rehydrated:")
    ? `${messageId}:${position}`
    : attachmentId;
}

function carriesAttachments(message: DisplayMessage): boolean {
  return (message.attachments?.length ?? 0) > 0;
}

/**
 * The rows carrying attachments, composed the way `useTranscriptMessages`
 * composes the whole transcript: the snapshot overlaid with the optimistic
 * sends by message identity, in snapshot order. The dismissed-surface filter
 * that read applies is left out because it only ever strips a row's surfaces,
 * never its attachments.
 */
function selectAttachmentRows(state: ChatSessionStore): DisplayMessage[] {
  return selectTranscriptMessages(
    (state.snapshot?.messages ?? []).filter(carriesAttachments),
    state.optimisticSends.filter(carriesAttachments),
  );
}

export function useConversationAttachments(target: {
  assistantId: string;
  conversationId: string;
}): ConversationAttachments {
  // The chat-session store names the conversation its snapshot was loaded for.
  // The navigation selection flips a render before that snapshot is cleared, so
  // gating on it would list the outgoing conversation's files under the new id.
  const ownerAssistantId = useChatSessionStore.use.previousAssistantId();
  const ownerConversationId = useChatSessionStore.use.previousConversationId();
  const ownsTranscript =
    ownerAssistantId === target.assistantId &&
    ownerConversationId === target.conversationId;

  const hasSnapshot = useChatSessionStore((state) => state.snapshot !== null);
  // The store's own loading flag, never its `error` field: a failed send sets
  // that too, and a send has nothing to say about the transcript.
  const isLoadingHistory = useChatSessionStore.use.isLoadingHistory();

  const messages = useChatSessionStore(useShallow(selectAttachmentRows));

  const entries = useMemo(() => {
    if (!ownsTranscript) {
      return NO_ENTRIES;
    }
    const collected: ConversationAttachmentEntry[] = [];
    const seen = new Set<string>();
    // Newest first, and an optimistic row plus its confirmed echo carry the
    // same attachment ids, so the first sighting wins.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      // A channel-deleted row keeps its content but renders as a tombstone,
      // so its files are not on show either.
      if (message.deletedAt) {
        continue;
      }
      const attachments = message.attachments ?? [];
      // Send order within a row: `mergedMessageIds` is also stamped for
      // stream-id reconciliation, so it cannot mark a concatenated row.
      for (let position = 0; position < attachments.length; position += 1) {
        const attachment = attachments[position]!;
        const key = entryKey(message.id, attachment.id, position);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        collected.push({
          key,
          attachment,
          capturedAt: message.timestamp ?? null,
          sightFrame: false,
        });
      }
    }
    return collected.length === 0 ? NO_ENTRIES : collected;
  }, [messages, ownsTranscript]);

  return useMemo(
    () => ({
      entries,
      totalFiles: entries.length,
      // The transcript path cannot produce a frame: it never sees the tag.
      totalFrames: 0,
      transcriptSettled: ownsTranscript && (hasSnapshot || !isLoadingHistory),
      hasMoreFiles: false,
      hasMoreFrames: false,
      loadMoreFiles: NOOP,
      loadMoreFrames: NOOP,
      source: "transcript",
    }),
    [entries, hasSnapshot, isLoadingHistory, ownsTranscript],
  );
}
