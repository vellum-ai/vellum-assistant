import { useMemo } from "react";

import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import { messageMatchKeys } from "@/domains/chat/utils/message-identity";
import type { DisplayAttachment } from "@/types/attachment-types";

/**
 * A message's attachments re-derived from the rendered transcript on every
 * render, so an open files panel picks up attachments that land while a
 * message is still streaming. Returns `null` when the message cannot be
 * found (paged out of the loaded transcript) so callers fall back to the
 * open-time snapshot.
 */
export function useLiveMessageAttachments(
  messageId: string | undefined,
): DisplayAttachment[] | null {
  const messages = useTranscriptMessages();
  return useMemo(() => {
    if (!messageId) {
      return null;
    }
    const message = messages.find((m) =>
      messageMatchKeys(m).includes(messageId),
    );
    return message?.attachments ?? null;
  }, [messages, messageId]);
}
