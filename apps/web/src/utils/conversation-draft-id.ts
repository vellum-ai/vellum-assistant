export function createDraftConversationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : // crypto.randomUUID is ubiquitous in modern browsers, but guard for edge
      // cases (older Safari / non-secure context) so draft creation does not
      // hard-crash.
      `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
