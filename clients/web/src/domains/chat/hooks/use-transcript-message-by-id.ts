import { useMemo } from "react";

import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import { messageMatchKeys } from "@/domains/chat/utils/message-identity";
import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * One transcript row resolved from the rendered transcript (server history ⊕
 * the in-flight turn) on every render, matched on any of its identity keys -
 * server id, merged ids, or the client nonce - so an optimistic row and its
 * confirmed echo both resolve.
 *
 * The shared lookup behind the live re-derive hooks
 * ({@link useLiveThinkingText}, {@link useLiveActivityGroup},
 * {@link useLiveMessageAttachments}), which keep an open detail panel
 * streaming instead of frozen at its open-time snapshot.
 *
 * Returns `undefined` when no `messageId` was supplied or the row is not in
 * the loaded transcript (paged out). Callers must distinguish that from a
 * resolved row whose derived content happens to be empty.
 */
export function useTranscriptMessageById(
  messageId: string | undefined,
): DisplayMessage | undefined {
  const messages = useTranscriptMessages();
  return useMemo(() => {
    if (!messageId) {
      return undefined;
    }
    return messages.find((m) => messageMatchKeys(m).includes(messageId));
  }, [messages, messageId]);
}
