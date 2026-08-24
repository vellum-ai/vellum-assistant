import { useEffect, useRef } from "react";

import { usePinnedApps } from "@/hooks/use-pinned-apps";

/**
 * Fire `onActiveAppUnpinned` for each app that stops being pinned, so the
 * parent can close a surface showing an app the user just removed. Renders
 * nothing.
 *
 * Driven by the difference between successive pin lists rather than by the
 * unpin action, so a pin cleared in another window or on another device closes
 * the app here too. That also covers deleting an app, which drops its pin.
 *
 * Switching assistants replaces the whole list and is not a wave of unpins, so
 * the baseline resets without reporting anything. Same for the first list to
 * arrive: before it there is nothing to have lost, and same for the list
 * changing hands when the daemon version resolves the pin-storage gate.
 */
export function useActiveAppPinSync(
  assistantId: string | null | undefined,
  onActiveAppUnpinned: (appId: string) => void,
) {
  const { pinnedAppIds, source } = usePinnedApps(assistantId);
  const previous = useRef<{ key: string | null; ids: Set<string> }>({
    key: null,
    ids: new Set(),
  });

  useEffect(() => {
    const key = `${source}:${assistantId ?? ""}`;
    const baseline = previous.current;
    previous.current = { key, ids: pinnedAppIds };
    if (baseline.key !== key) {
      return;
    }
    for (const appId of baseline.ids) {
      if (!pinnedAppIds.has(appId)) {
        onActiveAppUnpinned(appId);
      }
    }
  }, [assistantId, source, pinnedAppIds, onActiveAppUnpinned]);
}
