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

/**
 * Drop the stored last-viewed conversation for an assistant. Called when the
 * stored id is known to be gone server-side (a 404 on the detail endpoint),
 * so the next cold boot resolves its landing from live rows instead of
 * spending a request on the dead one. Serializing `null` writes the empty
 * string, which the accessor's parser reads back as `null`.
 */
export function clearLastViewedConversationId(assistantId: string): void {
  storage.save(assistantId, null);
}
