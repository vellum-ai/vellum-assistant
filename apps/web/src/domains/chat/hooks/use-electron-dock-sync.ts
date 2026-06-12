import { useEffect, useState } from "react";

import { setDockBadge, setDockSignedIn } from "@/runtime/dock";
import { setMenuPlatformSession } from "@/runtime/menu";
import { useHasPlatformSession, useIsAuthenticated } from "@/stores/auth-store";
import { useUnreadConversationCountQuery } from "@/hooks/conversation-queries";
import { getDeviceBool, watchDeviceSetting } from "@/utils/device-settings";

/**
 * Publish the data the Electron Dock cares about — unread conversation
 * count and signed-in state — to the main process via the
 * `window.vellum.dock.*` bridge. Both wrappers no-op on non-Electron
 * hosts (see `@/runtime/dock`), so this hook is safe to mount
 * unconditionally inside `ChatLayout`.
 *
 * The unread count is fetched from the daemon's dedicated
 * `GET /v1/conversations/unread-count` endpoint, which runs a single SQL
 * count query. This decouples badge accuracy from how many conversations
 * are loaded in the sidebar — the badge is always correct regardless of
 * pagination state.
 */
export function useElectronDockSync(assistantId: string | null): void {
  const isAuthenticated = useIsAuthenticated();
  const hasPlatformSession = useHasPlatformSession();
  const [dockBadgesEnabled, setDockBadgesEnabled] = useState(() =>
    getDeviceBool("dockBadgesEnabled", true),
  );

  const { count: unreadCount } = useUnreadConversationCountQuery(assistantId);

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
