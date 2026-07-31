// Persist the last-viewed conversation id per assistant to localStorage so
// that pages scoped to a single conversation (e.g. /assistant/logs) can
// restore the previous selection on initial page load instead of always
// defaulting to the first conversation in the list.

import { createKeyedStorageAccessor } from "@/utils/typed-storage";

const storage = createKeyedStorageAccessor<string | null>({
  keyFn: (assistantId) => `vellum:lastViewedConversation:${assistantId}`,
  scope: "user",
  parse: (raw) => (raw.length > 0 ? raw : null),
  serialize: (v) => v ?? "",
  fallback: null,
});

export function loadLastViewedConversationId(
  assistantId: string,
): string | null {
  return storage.load(assistantId);
}

export function saveLastViewedConversationId(
  assistantId: string,
  conversationId: string,
): void {
  storage.save(assistantId, conversationId);
}
