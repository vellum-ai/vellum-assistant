import { useEffect, useMemo, useState } from "react";

import { setDockBadge } from "@/runtime/dock";
import type { Conversation } from "@/types/conversation-types";
import { contributesToUnreadCount } from "@/utils/conversation-predicates";
import { getDeviceBool, watchDeviceSetting } from "@/utils/device-settings";

/**
 * Publish the Electron Dock's unread conversation count to the main
 * process via the `window.vellum.dock.*` bridge, which no-ops on
 * non-Electron hosts so this hook is safe to mount unconditionally
 * inside `ChatLayout`.
 *
 * Mount the hook once at a layout that already has the conversation
 * list in hand (currently `ChatLayout`, which subscribes to
 * `useConversationListQuery` at the route root). The count is derived
 * locally via `contributesToUnreadCount` (the same predicate that
 * drives sidebar attention indicators) so we don't fetch twice and
 * automated background / scheduled / archived threads don't contribute
 * to the badge.
 *
 * The app menu's platform-session state is published separately from
 * `RootLayout` (an always-mounted layer) so it stays correct on
 * non-chat routes where `ChatLayout` isn't mounted.
 */
export function useElectronDockSync(conversations: Conversation[]): void {
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
}
