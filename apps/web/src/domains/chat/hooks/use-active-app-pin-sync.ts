
import { useEffect } from "react";

import { usePinnedApps } from "@/domains/chat/lib/pinnedAppsContext.js";

/**
 * Subscribes to the pinned-apps context's unpin event stream and fires
 * `onActiveAppUnpinned` whenever an app is unpinned. This lets the parent
 * navigate away from a removed entry without rendering any visible UI.
 *
 * Must be called inside a `<PinnedAppsProvider>`.
 */
export function useActiveAppPinSync(
  onActiveAppUnpinned: (appId: string) => void,
) {
  const { onUnpin } = usePinnedApps();
  useEffect(
    () => onUnpin((id) => onActiveAppUnpinned(id)),
    [onUnpin, onActiveAppUnpinned],
  );
}
