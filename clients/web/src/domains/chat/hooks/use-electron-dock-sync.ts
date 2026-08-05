import { useEffect, useState } from "react";

import { useUnreadConversationCount } from "@/hooks/conversation-queries";
import { setDockBadge } from "@/runtime/dock";
import { isElectron } from "@/runtime/is-electron";
import type { Conversation } from "@/types/conversation-types";
import { getDeviceBool, watchDeviceSetting } from "@/utils/device-settings";

/**
 * Publish the unread conversation count to the Electron Dock badge via the
 * `window.vellum.dock.*` bridge, which no-ops on non-Electron hosts so this
 * hook is safe to mount unconditionally inside `ChatLayout`.
 *
 * Mount it once at a layout that already holds the conversation list
 * (currently `ChatLayout`), which supplies the fallback the count hook uses
 * when the assistant serves no server-side count.
 *
 * The count query is gated on three things, so nothing pays for a request it
 * cannot use: the Electron host (no other host draws a Dock badge), the badge
 * setting, and the assistant being active. The last matters because
 * `ChatLayout` mounts before the assistant finishes starting, and querying a
 * starting or stopped assistant would spend the retry budget on a request
 * that cannot succeed.
 *
 * The app menu's platform-session state is published separately from
 * `RootLayout` (an always-mounted layer) so it stays correct on non-chat
 * routes where `ChatLayout` isn't mounted.
 */
export function useElectronDockSync(
  assistantId: string | null,
  conversations: Conversation[],
  isAssistantActive: boolean,
): void {
  const [dockBadgesEnabled, setDockBadgesEnabled] = useState(() =>
    getDeviceBool("dockBadgesEnabled", true),
  );

  const unreadCount = useUnreadConversationCount(
    assistantId,
    conversations,
    isElectron() && dockBadgesEnabled && isAssistantActive,
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
