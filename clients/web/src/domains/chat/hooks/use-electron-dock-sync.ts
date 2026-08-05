import { useEffect, useMemo, useState } from "react";

import { useUnreadConversationCountQuery } from "@/hooks/conversation-queries";
import { setDockBadge } from "@/runtime/dock";
import { isElectron } from "@/runtime/is-electron";
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
 * `useConversationListQuery` at the route root).
 *
 * The badge value prefers the server-side count
 * (`useUnreadConversationCountQuery`), which covers every conversation
 * regardless of which pages the client has loaded. When the count is
 * unavailable (assistant predates the endpoint, or the query hasn't
 * resolved), it falls back to counting the passed-in list via
 * `contributesToUnreadCount`, the same predicate that drives sidebar
 * attention indicators, so background / scheduled / archived threads
 * never contribute to the badge. The query is Electron-gated: no other
 * host renders a dock badge, so no other host pays the fetch.
 *
 * The app menu's platform-session state is published separately from
 * `RootLayout` (an always-mounted layer) so it stays correct on
 * non-chat routes where `ChatLayout` isn't mounted.
 */
export function useElectronDockSync(
  assistantId: string | null,
  conversations: Conversation[],
): void {
  const [dockBadgesEnabled, setDockBadgesEnabled] = useState(() =>
    getDeviceBool("dockBadgesEnabled", true),
  );

  const serverUnreadCount = useUnreadConversationCountQuery(
    assistantId,
    isElectron() && dockBadgesEnabled,
  );

  const derivedUnreadCount = useMemo(
    () =>
      conversations.reduce(
        (n, c) => (contributesToUnreadCount(c) ? n + 1 : n),
        0,
      ),
    [conversations],
  );

  const unreadCount = serverUnreadCount ?? derivedUnreadCount;

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
