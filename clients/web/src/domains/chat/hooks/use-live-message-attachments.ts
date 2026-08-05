import { useTranscriptMessageById } from "@/domains/chat/hooks/use-transcript-message-by-id";
import type { DisplayAttachment } from "@/types/attachment-types";

/** Stable empty result, so a resolved message with no attachments doesn't
 *  hand callers a fresh array on every render. */
const NO_ATTACHMENTS: DisplayAttachment[] = [];

/**
 * A message's attachments re-derived from the rendered transcript on every
 * render, so an open files panel picks up attachments that land while a
 * message is still streaming.
 *
 * Returns `null` only when the message itself cannot be resolved (paged out
 * of the loaded transcript), so callers fall back to the open-time snapshot.
 * A message that resolves with no attachments returns an empty array, not
 * `null` - it is a live answer, and the panel must show its empty state
 * rather than resurrect a stale snapshot.
 */
export function useLiveMessageAttachments(
  messageId: string | undefined,
): DisplayAttachment[] | null {
  const message = useTranscriptMessageById(messageId);
  if (!message) {
    return null;
  }
  return message.attachments ?? NO_ATTACHMENTS;
}
