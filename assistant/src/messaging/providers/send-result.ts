/**
 * The outcome of a send that may have created several provider posts.
 *
 * Shared by the senders that split text into chunks (Telegram, Discord) so
 * the two facts a caller needs are derived one way:
 *
 * - `messageIds` is every id the provider acknowledged, in send order, with
 *   nothing invented for a response that carried none. A recorder names each
 *   of these, since a reaction, edit, or delete can land on any chunk.
 * - `lastMessageId` is the id of the final post specifically, because that is
 *   the post carrying the buttons on an approval card and the one a later
 *   edit or withdrawal must address. It is absent when the final response
 *   carried no id, never substituted by an earlier chunk's id, since editing
 *   the wrong message is worse than editing none.
 */
export interface AcknowledgedSend {
  lastMessageId?: string;
  messageIds: string[];
}

/**
 * Derive the outcome from the id of each post the send created, in send
 * order, `undefined` where the provider's response carried none.
 */
export function acknowledgedSend(
  idsInSendOrder: ReadonlyArray<string | undefined>,
): AcknowledgedSend {
  const lastMessageId = idsInSendOrder[idsInSendOrder.length - 1];
  const messageIds = idsInSendOrder.filter(
    (id): id is string => id !== undefined,
  );
  return lastMessageId !== undefined
    ? { lastMessageId, messageIds }
    : { messageIds };
}
