/**
 * Per-conversation pinned-tab store for the Chrome extension browser
 * backend.
 *
 * When a navigate is issued with `new_tab: true`, the executor first
 * asks the extension to open a fresh tab (via the `Vellum.createTab`
 * pseudo-CDP method), then records the returned tabId here against the
 * conversation. Subsequent CDP commands constructed for the same
 * conversation pick up this tabId as the `cdpSessionId` on the
 * outgoing envelope, which causes the extension's
 * `resolveHostBrowserTarget` to route to that specific tab instead of
 * falling back to `chrome.tabs.query({ active: true })`.
 *
 * Persistence is process-lifetime (in-memory only). The daemon is a
 * single process and all CLI invocations land in it via IPC, so a
 * module-level Map is sufficient. A pin is cleared when the extension
 * reports the underlying CDP target as invalidated (see
 * `consumeInvalidatedTargetId` in `browser-session/events.ts`) — that
 * eviction is wired through `BrowserSessionManager.invalidateByTargetId`
 * and the host-browser session-invalidated event route.
 */

import { log } from "../../cli/logger.js";

const pinnedTabs = new Map<string, string>();

/**
 * Record a tabId as the pinned tab for the given conversation. The
 * tabId is stored as a string because it travels on the wire as
 * `cdpSessionId` (a string-typed field on the host-browser envelope).
 */
export function setPinnedTab(conversationId: string, tabId: string): void {
  if (!conversationId || !tabId) return;
  pinnedTabs.set(conversationId, tabId);
  log.debug(
    { conversationId, tabId },
    "Pinned extension tab for conversation",
  );
}

/**
 * Return the tabId pinned to the given conversation, or undefined if
 * no pin exists.
 */
export function getPinnedTab(conversationId: string): string | undefined {
  if (!conversationId) return undefined;
  return pinnedTabs.get(conversationId);
}

/**
 * Clear the pin for the given conversation. Idempotent — clearing a
 * non-existent pin is a no-op.
 */
export function clearPinnedTab(conversationId: string): void {
  if (!conversationId) return;
  if (pinnedTabs.delete(conversationId)) {
    log.debug({ conversationId }, "Cleared pinned extension tab");
  }
}

/**
 * Clear every pin pointing at a given tabId across all conversations.
 * Used when the extension reports a target as invalidated (tab closed,
 * crashed, navigated away from a debuggable URL, etc.) so we don't
 * keep routing to a dead tab.
 *
 * Returns the number of conversations whose pin was cleared.
 */
export function clearPinnedTabByTabId(tabId: string): number {
  if (!tabId) return 0;
  let cleared = 0;
  for (const [conversationId, pinned] of pinnedTabs.entries()) {
    if (pinned === tabId) {
      pinnedTabs.delete(conversationId);
      cleared++;
      log.debug(
        { conversationId, tabId },
        "Cleared pinned extension tab due to invalidation",
      );
    }
  }
  return cleared;
}

/**
 * Reset the entire pin store. Test-only.
 */
export function __resetPinnedTabsForTests(): void {
  pinnedTabs.clear();
}
