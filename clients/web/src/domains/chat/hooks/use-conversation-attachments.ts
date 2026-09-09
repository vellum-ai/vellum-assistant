/**
 * Every attachment a conversation carries, newest first.
 *
 * Read from the rendered transcript, which is the loaded pages only, so
 * `totalFiles` counts what is loaded rather than what the conversation holds.
 * The transcript also cannot see the camera-frame tag: that lives in daemon
 * message metadata which never crosses the message wire, so `sightFrame` is
 * always false and `totalFrames` is always 0 on this source.
 */

import { useMemo } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
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
  /** Carrying transcript row. */
  messageId: string;
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

  const messages = useTranscriptMessages();

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
      // A folded row appends the newer donor's files after the survivor's, so
      // only those are walked from the end; one upload keeps the order it was
      // sent in.
      const folded = (message.mergedMessageIds?.length ?? 0) > 0;
      for (let step = 0; step < attachments.length; step += 1) {
        const position = folded ? attachments.length - 1 - step : step;
        const attachment = attachments[position]!;
        const key = entryKey(message.id, attachment.id, position);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        collected.push({
          key,
          attachment,
          messageId: message.id,
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
      totalFrames: 0,
      hasMoreFiles: false,
      hasMoreFrames: false,
      loadMoreFiles: NOOP,
      loadMoreFrames: NOOP,
      source: "transcript",
    }),
    [entries],
  );
}
