// Persist the last-viewed conversation key per assistant to localStorage so
// that pages scoped to a single conversation (e.g. /assistant/logs) can
// restore the previous selection on initial page load instead of always
// defaulting to the first conversation in the list.

const STORAGE_KEY_PREFIX = "vellum:lastViewedConversation:";

function storageKey(assistantId: string): string {
  return `${STORAGE_KEY_PREFIX}${assistantId}`;
}

export function loadLastViewedConversationKey(
  assistantId: string,
): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(storageKey(assistantId));
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function saveLastViewedConversationKey(
  assistantId: string,
  conversationId: string,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(storageKey(assistantId), conversationId);
  } catch {
    // Storage can fail in private browsing / quota-exceeded cases. Silently
    // drop; the in-memory selection still works for the current session.
  }
}
