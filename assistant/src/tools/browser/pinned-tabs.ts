/**
 * Per-conversation, per-client pinned-tab store for the Chrome extension
 * browser backend.
 *
 * Pin store key is (conversationId, clientId) → tabId. This scopes pins
 * to a specific extension instance so that closing a tab on clientA does
 * not clear clientB's pin to a tab with the same numeric ID on a
 * different Chrome instance (issue #31361).
 *
 * Persistence is process-lifetime (in-memory only). The daemon is a
 * single process and all CLI invocations land in it via IPC, so a
 * module-level Map is sufficient. A pin is cleared when the extension
 * reports the underlying CDP target as invalidated via
 * `host_browser_session_invalidated`.
 */

import { log } from "../../cli/logger.js";

const pinnedTabs = new Map<string, Map<string, string>>();

/**
 * Record a tabId as the pinned tab for the given conversation and optional
 * client. The tabId is stored as a string because it travels on the wire
 * as `cdpSessionId` (a string-typed field on the host-browser envelope).
 */
export function setPinnedTab(
  conversationId: string,
  tabId: string,
  clientId?: string,
): void {
  if (!conversationId || !tabId) return;
  const key = clientId ?? "__default__";
  let inner = pinnedTabs.get(conversationId);
  if (!inner) {
    inner = new Map();
    pinnedTabs.set(conversationId, inner);
  }
  inner.set(key, tabId);
  log.debug(
    { conversationId, clientId, tabId },
    "Pinned extension tab for conversation",
  );
}

/**
 * Return the tabId pinned to the given conversation and optional client,
 * or undefined if no pin exists.
 *
 * When `clientId` is provided, returns the pin for that client first,
 * falling back to the `__default__` slot. When no `clientId` is given,
 * returns the first entry (best-guess for auto-routing).
 */
export function getPinnedTab(
  conversationId: string,
  clientId?: string,
): string | undefined {
  if (!conversationId) return undefined;
  const inner = pinnedTabs.get(conversationId);
  if (!inner) return undefined;
  if (clientId !== undefined) {
    return inner.get(clientId) ?? inner.get("__default__");
  }
  // No clientId: return the first entry (best-guess for auto-routing)
  const first = inner.values().next();
  return first.done ? undefined : first.value;
}

/**
 * Clear the pin for the given conversation and optional client. Idempotent
 * — clearing a non-existent pin is a no-op.
 *
 * When `clientId` is provided, only clears that client's slot. When
 * omitted, clears all client slots for the conversation.
 */
export function clearPinnedTab(
  conversationId: string,
  clientId?: string,
): void {
  if (!conversationId) return;
  const inner = pinnedTabs.get(conversationId);
  if (!inner) return;
  if (clientId !== undefined) {
    if (inner.delete(clientId)) {
      log.debug({ conversationId, clientId }, "Cleared pinned extension tab");
    }
    if (inner.size === 0) pinnedTabs.delete(conversationId);
  } else {
    // Clear all clients for this conversation
    if (pinnedTabs.delete(conversationId)) {
      log.debug(
        { conversationId },
        "Cleared all pinned extension tabs for conversation",
      );
    }
  }
}

/**
 * Clear every pin pointing at a given tabId across all conversations.
 * Used when the extension reports a target as invalidated (tab closed,
 * crashed, navigated away from a debuggable URL, etc.) so we don't
 * keep routing to a dead tab.
 *
 * When `clientId` is provided, only clears the slot for that client.
 * When omitted, clears all entries pointing at this tabId (backward compat).
 *
 * Returns the number of slots cleared.
 */
export function clearPinnedTabByTabId(tabId: string, clientId?: string): number {
  if (!tabId) return 0;
  let cleared = 0;
  for (const [conversationId, inner] of pinnedTabs.entries()) {
    if (clientId !== undefined) {
      // Only clear the specific client's slot if its tabId matches
      if (inner.get(clientId) === tabId) {
        inner.delete(clientId);
        cleared++;
        log.debug(
          { conversationId, clientId, tabId },
          "Cleared pinned extension tab due to invalidation",
        );
      }
    } else {
      // Backward compat: clear all entries pointing at this tabId
      for (const [cid, pinned] of inner.entries()) {
        if (pinned === tabId) {
          inner.delete(cid);
          cleared++;
          log.debug(
            { conversationId, clientId: cid, tabId },
            "Cleared pinned extension tab due to invalidation",
          );
        }
      }
    }
    if (inner.size === 0) pinnedTabs.delete(conversationId);
  }
  return cleared;
}

/**
 * Reset the entire pin store. Test-only.
 */
export function __resetPinnedTabsForTests(): void {
  pinnedTabs.clear();
}
