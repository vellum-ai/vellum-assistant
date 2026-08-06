/**
 * In-memory registry of Telegram Verification topics pending teardown.
 *
 * When threaded mode is on, verification runs in a dedicated bot topic. On
 * successful code entry the gateway deletes that topic and confirms in the
 * main chat. Only topics recorded here are eligible — never an ordinary
 * assistant topic where a user pastes a still-valid code.
 *
 * In-memory is sufficient: a gateway restart skips best-effort teardown,
 * which is safe. Entries expire after a TTL so stale mappings cannot delete
 * unrelated topics later.
 */

const VERIFICATION_TOPIC_TTL_MS = 30 * 60_000;

const verificationTopics = new Map<
  string,
  { threadId: string; expiresAt: number }
>();

export function rememberVerificationTopic(
  chatId: string,
  threadId: string,
): void {
  verificationTopics.set(chatId, {
    threadId,
    expiresAt: Date.now() + VERIFICATION_TOPIC_TTL_MS,
  });
}

export function isVerificationTopic(chatId: string, threadId: string): boolean {
  const entry = verificationTopics.get(chatId);
  if (!entry) {
    return false;
  }
  if (Date.now() > entry.expiresAt) {
    verificationTopics.delete(chatId);
    return false;
  }
  return entry.threadId === threadId;
}

export function forgetVerificationTopic(chatId: string): void {
  verificationTopics.delete(chatId);
}

/** Test-only: clear all entries between cases. */
export function resetVerificationTopicRegistryForTesting(): void {
  verificationTopics.clear();
}
