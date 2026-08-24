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
 * arrive: before it there is nothing to have lost.
 */
export function useActiveAppPinSync(
  assistantId: string | null | undefined,
  onActiveAppUnpinned: (appId: string) => void,
) {
  const { pinnedAppIds } = usePinnedApps(assistantId);
  const previous = useRef<{ assistantId: string | null; ids: Set<string> }>({
    assistantId: null,
    ids: new Set(),
  });

  useEffect(() => {
    const id = assistantId ?? null;
    const baseline = previous.current;
    previous.current = { assistantId: id, ids: pinnedAppIds };
    if (baseline.assistantId !== id) {
      return;
    }
    for (const appId of baseline.ids) {
      if (!pinnedAppIds.has(appId)) {
        onActiveAppUnpinned(appId);
      }
    }
  }, [assistantId, pinnedAppIds, onActiveAppUnpinned]);
}
