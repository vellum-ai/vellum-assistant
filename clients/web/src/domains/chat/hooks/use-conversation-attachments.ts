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

import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import type { DisplayAttachment } from "@/types/attachment-types";

/** Page size for a paged attachment listing. */
export const ATTACHMENT_PAGE_SIZE = 200;

export interface ConversationAttachmentEntry {
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

export function useConversationAttachments(target: {
  assistantId: string;
  conversationId: string;
}): ConversationAttachments {
  // The transcript is already the open conversation's, so this source has
  // nothing to scope by; `target` names the conversation the entries belong to.
  void target;

  const messages = useTranscriptMessages();

  const entries = useMemo(() => {
    const collected: ConversationAttachmentEntry[] = [];
    const seen = new Set<string>();
    // Newest first, and an optimistic row plus its confirmed echo carry the
    // same attachment ids, so the first sighting wins.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      for (const attachment of message.attachments ?? []) {
        // A legacy row without structured metadata gets `rehydrated:N` ids
        // that restart per message, so those are only duplicates within their
        // own row; real attachment ids are unique across the conversation.
        const key = attachment.id.startsWith("rehydrated:")
          ? `${message.id}:${attachment.id}`
          : attachment.id;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        collected.push({
          attachment,
          messageId: message.id,
          capturedAt: message.timestamp ?? null,
          sightFrame: false,
        });
      }
    }
    return collected.length === 0 ? NO_ENTRIES : collected;
  }, [messages]);

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
