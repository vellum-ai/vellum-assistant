
import { useEffect } from "react";

import { usePinnedAppsStore } from "@/stores/pinned-apps-store";

/**
 * Subscribes to the pinned-apps store's unpin event stream and fires
 * `onActiveAppUnpinned` whenever an app is unpinned. This lets the parent
 * navigate away from a removed entry without rendering any visible UI.
 */
export function useActiveAppPinSync(
  onActiveAppUnpinned: (appId: string) => void,
) {
  const onUnpin = usePinnedAppsStore.use.onUnpin();
  useEffect(
    () => onUnpin((id) => onActiveAppUnpinned(id)),
    [onUnpin, onActiveAppUnpinned],
  );
}
