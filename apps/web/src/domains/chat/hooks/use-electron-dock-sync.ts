import { useEffect, useMemo, useState } from "react";

import { setDockBadge, setDockSignedIn } from "@/runtime/dock";
import { setMenuPlatformSession } from "@/runtime/menu";
import { useHasPlatformSession, useIsAuthenticated } from "@/stores/auth-store";
import type { Conversation } from "@/types/conversation-types";
import { contributesToUnreadCount } from "@/utils/conversation-predicates";
import { getDeviceBool, watchDeviceSetting } from "@/utils/device-settings";

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
 * locally via `contributesToUnreadCount` (the same predicate that
 * drives sidebar attention indicators) so we don't fetch twice and
 * automated background / scheduled / archived threads don't contribute
 * to the badge.
 *
 * The signed-in input is temporary: once main owns auth state
 * directly, main becomes the source of truth and this side of the
 * bridge becomes a no-op. (Main also clears the badge when signed-in
 * flips to false so a logout-driven remount of this layout can't leave
 * a stale count on the Dock.)
 */
export function useElectronDockSync(conversations: Conversation[]): void {
  const isAuthenticated = useIsAuthenticated();
  const hasPlatformSession = useHasPlatformSession();
  const [dockBadgesEnabled, setDockBadgesEnabled] = useState(() =>
    getDeviceBool("dockBadgesEnabled", true),
  );

  const unreadCount = useMemo(
    () =>
      conversations.reduce(
        (n, c) => (contributesToUnreadCount(c) ? n + 1 : n),
        0,
      ),
    [conversations],
  );

  useEffect(
    () =>
      watchDeviceSetting("dockBadgesEnabled", () => {
        setDockBadgesEnabled(getDeviceBool("dockBadgesEnabled", true));
      }),
    [],
  );

  useEffect(() => {
    setDockBadge(dockBadgesEnabled ? unreadCount : 0);
  }, [dockBadgesEnabled, unreadCount]);

  useEffect(() => {
    setDockSignedIn(isAuthenticated);
  }, [isAuthenticated]);

  useEffect(() => {
    void setMenuPlatformSession(hasPlatformSession);
  }, [hasPlatformSession]);
}
