import { useEffect, useMemo } from "react";

import { setDockBadge, setDockSignedIn } from "@/runtime/dock";
import { useAuthStore } from "@/stores/auth-store";
import type { Conversation } from "@/types/conversation-types";

/**
 * Publish the data the Electron Dock cares about — unread conversation
 * count and signed-in state — to the main process via the
 * `window.vellum.dock.*` bridge. Both wrappers no-op on non-Electron
 * hosts (see `@/runtime/dock`), so this hook is safe to mount
 * unconditionally inside `ChatLayout`.
 *
 * Mount the hook once at a layout that already has the conversation
 * list in hand (currently `ChatLayout`, which subscribes to
 * `useConversationListQuery` at the route root). The count is derived
 * locally from `hasUnseenLatestAssistantMessage` — same predicate Swift
 * Vellum's `unseenVisibleConversationCount` uses — so we don't fetch
 * twice.
 *
 * The signed-in input is temporary: once LUM-1924 wires BFF auth into
 * the main process, main becomes the source of truth and this side of
 * the bridge becomes a no-op.
 */
export function useElectronDockSync(conversations: Conversation[]): void {
  const isLoggedIn = useAuthStore.use.isLoggedIn();

  const unreadCount = useMemo(
    () =>
      conversations.reduce(
        (n, c) => (c.hasUnseenLatestAssistantMessage ? n + 1 : n),
        0,
      ),
    [conversations],
  );

  useEffect(() => {
    void setDockBadge(unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    void setDockSignedIn(isLoggedIn);
  }, [isLoggedIn]);
}
