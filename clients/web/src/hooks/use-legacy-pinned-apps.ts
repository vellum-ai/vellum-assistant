/**
 * LEGACY. Pinned apps as the browser stores them, for daemons that do not
 * advertise the `appPins` capability.
 *
 * One half of the choice {@link usePinnedApps} makes; the daemon half lives
 * beside it. Kept in its own file so the split is structural rather than a
 * branch in every action, and so retiring the capability gate is a delete
 * rather than an untangle.
 *
 * See `utils/app-pin-storage.ts` for the key this reads and why its behaviour
 * is preserved rather than corrected.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { AppSummary } from "@/types/app-types";
import {
  loadPinnedApps,
  pinApp,
  setAppColor,
  subscribePinnedApps,
  unpinApp,
} from "@/utils/app-pin-storage";
import type { PinnedAppsBackend, PinnedAppView } from "@/hooks/pinned-apps";

/**
 * @param apps the assistant's apps, which this needs because a stored pin
 * copies the name and icon off the app at pin time.
 */
export function useLegacyPinnedApps(
  apps: readonly AppSummary[],
): PinnedAppsBackend {
  const entries = useSyncExternalStore(
    subscribePinnedApps,
    loadPinnedApps,
    loadPinnedApps,
  );

  const pinnedApps = useMemo(
    (): PinnedAppView[] =>
      [...entries]
        .sort((a, b) => a.pinnedOrder - b.pinnedOrder)
        .map((entry) => ({
          id: entry.appId,
          name: entry.name,
          icon: entry.icon,
          pinColor: entry.color,
        })),
    [entries],
  );

  const pinnedIds = useMemo(
    () => new Set(pinnedApps.map((app) => app.id)),
    [pinnedApps],
  );

  const togglePin = useCallback(
    (appId: string) => {
      if (pinnedIds.has(appId)) {
        unpinApp(appId);
        return;
      }
      const app = apps.find((candidate) => candidate.id === appId);
      if (app) {
        pinApp({ id: app.id, name: app.name, icon: app.icon });
      }
    },
    [pinnedIds, apps],
  );

  const unpin = useCallback(
    (appId: string) => {
      if (pinnedIds.has(appId)) {
        unpinApp(appId);
      }
    },
    [pinnedIds],
  );

  const setColor = useCallback(
    (appId: string, color: string | null) => {
      if (pinnedIds.has(appId)) {
        setAppColor(appId, color);
      }
    },
    [pinnedIds],
  );

  return { pinnedApps, togglePin, unpin, setColor };
}
