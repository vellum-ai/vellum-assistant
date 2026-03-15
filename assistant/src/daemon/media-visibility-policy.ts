/**
 * Centralized policy for attachment visibility across conversation types.
 *
 * Private-conversation attachments are scoped: they are only visible when the
 * current context is the *same* private conversation. Standard (non-private)
 * conversation attachments are visible everywhere.
 *
 * This is a pure policy module -- no IO, no database queries, just logic.
 * Actual enforcement in tools happens downstream (e.g., attachment-list
 * and attachment-retrieve tools check this before returning results).
 */

export interface AttachmentContext {
  conversationId: string;
  /** Callers must always resolve this — omitting it would silently fail open. */
  isPrivate: boolean;
}

/**
 * Determine whether a single attachment is visible from the given context.
 *
 * Rules:
 * 1. Attachments from standard (non-private) conversations are always visible.
 * 2. Attachments from private conversations are only visible when the current
 *    context matches the same private conversation (same conversationId).
 */
export function isAttachmentVisible(
  attachment: AttachmentContext,
  currentContext: AttachmentContext,
): boolean {
  // Standard conversation attachments are universally visible
  if (!attachment.isPrivate) {
    return true;
  }

  // Private conversation attachments require the viewer to be in the same private conversation
  return (
    currentContext.isPrivate === true &&
    currentContext.conversationId === attachment.conversationId
  );
}

/**
 * Filter a list of attachments to only those visible from the current context.
 *
 * @param attachments - The full list of attachments to filter.
 * @param currentContext - The conversation context from which visibility is evaluated.
 * @param getContext - Extracts the conversation context from each attachment
 *   record (since the caller's attachment type may differ from AttachmentContext).
 */
export function filterVisibleAttachments<T>(
  attachments: T[],
  currentContext: AttachmentContext,
  getContext: (attachment: T) => AttachmentContext,
): T[] {
  return attachments.filter((a) =>
    isAttachmentVisible(getContext(a), currentContext),
  );
}
