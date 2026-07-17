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

  const messageEl = resolveAssistantMessageElement(
    selection.anchorNode,
    container,
  );
  if (!messageEl) {
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
 * Whether `node` sits inside an assistant message contained by `container`.
 *
 * Unlike `resolveAssistantSelection`, this consults only the DOM position of a
 * node, not the window selection — so it is usable from a `selectstart`
 * handler, where the new selection range is not yet associated and
 * `window.getSelection()` still reports an empty/collapsed selection.
 */
export function isAssistantMessageNode(
  node: Node | null,
  container: HTMLElement | null,
): boolean {
  return resolveAssistantMessageElement(node, container) !== null;
}

/**
 * Resolve a DOM node to the enclosing assistant message element, or `null`
 * when the node is not inside an assistant message contained by `container`.
 */
function resolveAssistantMessageElement(
  node: Node | null,
  container: HTMLElement | null,
): HTMLElement | null {
  if (!node) {
    return null;
  }

  const messageEl = findMessageElement(node);
  if (!messageEl) {
    return null;
  }

  if (!container || !container.contains(messageEl)) {
    return null;
  }

  if (messageEl.getAttribute("data-message-role") !== "assistant") {
    return null;
  }

  if (!messageEl.getAttribute("data-message-id")) {
    return null;
  }

  return messageEl;
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
