/**
 * Sticky one-shot signal: "the next conversation that loads should
 * auto-greet."
 *
 * Why a sticky one-shot and not a bus event or store flag:
 *   - A bus event is lost across the `/assistant` →
 *     `/assistant/conversations/:id` redirect that `useConversationLoader`
 *     performs after a fresh hatch — `ChatPage` remounts, the subscription
 *     captured by the first instance evaporates, and the destination mount
 *     has no listener.
 *   - A live Zustand store flag would persist across mount/unmount cycles
 *     but couples chat-surface state into the lifecycle store. The
 *     persistence we want is across THIS browser tab only (not across
 *     reloads), and sessionStorage is the natural fit.
 *   - Sticky-in-sessionStorage matches the established pattern used by
 *     the onboarding flow's `peekPendingPreChatContext` /
 *     `consumePendingPreChatContext`.
 *
 * Writer: `lifecycle-service.ts` (auto_hatch happy path, `hatchVersion`).
 * Reader: `chat-page.tsx` (initial state via `peek`, cleared via `consume`).
 */

const STORAGE_KEY = "assistant.lifecycle.autoGreetPending";

function getSessionStorage(): Storage | null {
  try {
    const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

export function setAutoGreetPending(): void {
  const storage = getSessionStorage();
  if (storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, "1");
  } catch {
    // Storage unavailable (private mode, quota) — caller silently
    // degrades to "no auto-greet on this hatch."
  }
}

export function peekAutoGreetPending(): boolean {
  const storage = getSessionStorage();
  if (storage === null) return false;
  try {
    return storage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function consumeAutoGreetPending(): boolean {
  if (!peekAutoGreetPending()) return false;
  const storage = getSessionStorage();
  if (storage === null) return false;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort clear; the next consume will see the same value
    // and bail at `peek`.
  }
  return true;
}

/**
 * Test-only: drop the stored value without consuming. Production
 * code should call `consumeAutoGreetPending()` instead — the consume
 * semantics are the load-bearing part.
 */
export function __resetAutoGreetSignalForTesting(): void {
  const storage = getSessionStorage();
  if (storage === null) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // ignored
  }
}
