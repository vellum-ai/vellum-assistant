/**
 * Waiting for a conversation to come out of a turn.
 *
 * Shared by the ingestion paths that persist a user message and run no turn —
 * a live-voice photo, a watch-session timeline entry. Each needs the
 * conversation's processing lock, which a running turn holds for as long as it
 * runs, tools included. They wait rather than queue because the conversation's
 * queue drains into a turn, which is the one thing these paths must not cause.
 */

const IDLE_POLL_MS = 100;

/**
 * Resolve true once the conversation is not mid-turn, or false at `timeoutMs`.
 *
 * The timeout is the caller's call: how long a not-yet-stored entry is worth
 * blocking on differs by what the entry is.
 */
export async function waitForConversationIdle(
  conversation: { isProcessing: () => boolean },
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (conversation.isProcessing()) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
  }
  return true;
}
