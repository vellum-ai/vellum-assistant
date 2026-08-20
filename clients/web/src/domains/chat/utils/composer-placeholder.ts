/**
 * Which placeholder the chat composer shows.
 *
 * A fresh conversation keeps its neutral prompt at every width. The
 * assistant's name reaches the page from a query that settles after the
 * first paint, so letting it rewrite the placeholder would change the copy
 * under the reader's eyes while the rest of the empty state is still filling
 * in, which reads as the page loading rather than as one screen arriving.
 *
 * Once the conversation has messages, a narrow composer is one slim row with
 * no space for a sentence, so it names the assistant it is addressed to
 * instead. An assistant whose name has not loaded keeps the wider copy.
 */

export interface ComposerPlaceholderInput {
  /** True on a conversation with no messages yet. */
  isEmptyConversation: boolean;
  /** The neutral prompt drawn for a fresh conversation. */
  emptyStatePlaceholder: string;
  /**
   * Copy naming the assistant, or `null` when the composer is not narrow
   * enough to need it or the name has not loaded.
   */
  assistantPlaceholder: string | null;
  /** Copy for an active conversation with no assistant name to show. */
  defaultPlaceholder: string;
}

export function resolveComposerPlaceholder({
  isEmptyConversation,
  emptyStatePlaceholder,
  assistantPlaceholder,
  defaultPlaceholder,
}: ComposerPlaceholderInput): string {
  if (isEmptyConversation) {
    return emptyStatePlaceholder;
  }
  return assistantPlaceholder ?? defaultPlaceholder;
}
