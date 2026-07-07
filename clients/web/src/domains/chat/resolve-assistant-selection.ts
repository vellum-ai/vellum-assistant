/**
 * Shared resolution of the active text selection to an assistant message,
 * used by both the web floating "Reply" chip (`TextSelectionPopover`) and
 * the native iOS edit-menu "Reply" item bridge (`useNativeQuoteReply`).
 *
 * A selection qualifies for quote-and-reply only when it is non-empty and
 * lives inside an assistant message wrapper — identified by `data-message-id`
 * + `data-message-role="assistant"` — that is contained by the transcript
 * scroll container.
 */

export interface ResolvedAssistantSelection {
  /** Trimmed selected text. */
  text: string;
  /** `data-message-id` of the enclosing assistant message. */
  messageId: string;
  /** Bounding rect of the selection range, in viewport coordinates. */
  rect: DOMRect;
}

/**
 * Resolve the current window selection to an assistant message inside
 * `container`, or `null` when the selection is collapsed, empty, or does not
 * fall within an assistant message.
 */
export function resolveAssistantSelection(
  container: HTMLElement | null,
): ResolvedAssistantSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    return null;
  }

  const text = selection.toString().trim();
  if (!text) {
    return null;
  }

  const anchorNode = selection.anchorNode;
  if (!anchorNode) {
    return null;
  }

  const messageEl = findMessageElement(anchorNode);
  if (!messageEl) {
    return null;
  }

  if (!container || !container.contains(messageEl)) {
    return null;
  }

  if (messageEl.getAttribute("data-message-role") !== "assistant") {
    return null;
  }

  const messageId = messageEl.getAttribute("data-message-id");
  if (!messageId) {
    return null;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return { text, messageId, rect };
}

/**
 * Walk from a DOM node upward to find the closest element with
 * `data-message-id` — the transcript row wrapper.
 */
function findMessageElement(node: Node): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (
      current instanceof HTMLElement &&
      current.hasAttribute("data-message-id")
    ) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}
