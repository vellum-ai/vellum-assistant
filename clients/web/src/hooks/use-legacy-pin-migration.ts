/**
 * Hand the browser's old pinned-app list to the daemon, once per assistant.
 *
 * The `vellum:pinnedApps` key holds one list for the whole browser profile,
 * shared by every assistant. That is the defect this migration exists to clean
 * up, and it makes the stored list a union of pins from every assistant the
 * user has opened, with nothing in it saying which pin belongs to which.
 *
 * The app list is the discriminator that splits the union back apart: an id is
 * this assistant's only if this assistant has an app with that id. So each
 * assistant claims its own entries on first load and leaves the rest in place
 * for whichever assistant owns them, and the key is dropped once nothing is
 * left to claim. {@link planLegacyPinClaim} holds what it refuses to move.
 */

import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  appsByIdPinPostMutation,
  appsGetOptions,
  appsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useSupportsDaemonAppPins } from "@/lib/backwards-compat/daemon-app-pins";
import {
  loadPinnedApps,
  removePinnedApps,
  savePinnedApps,
  type PinnedAppEntry,
} from "@/utils/app-pin-storage";

/** Keep what is still unclaimed, dropping the key once nothing is. */
function writeRemaining(pins: PinnedAppEntry[]): void {
  if (pins.length === 0) {
    removePinnedApps();
    return;
  }
  savePinnedApps(pins);
}

/**
 * The entries this assistant should claim from the legacy list, in the order
 * they should be pinned. Empty means claim nothing.
 *
 * It refuses two things, because a migration that guesses about state we
 * distrust is worse than one that stops: it never merges into an assistant
 * that already has pins of its own, and it never claims an id it cannot find
 * an app for, which is either another assistant's or a deleted app's.
 */
export function planLegacyPinClaim(
  legacy: PinnedAppEntry[],
  apps: { id: string; origin?: string; pinSortPosition?: number }[],
): PinnedAppEntry[] {
  if (apps.some((app) => app.pinSortPosition !== undefined)) {
    return [];
  }
  /*
   * Only a workspace app's id proves ownership. It is opaque and belongs to one
   * assistant, so finding it here means this assistant is where the pin was
   * made. A plugin app's id is `plugins~<plugin>~<appDir>`, which every
   * assistant with that plugin installed reports, so it identifies the app and
   * says nothing about who pinned it. Claiming one would let whichever
   * assistant loads first adopt a pin made under another and write it to the
   * daemon, turning the ambiguity this migration exists to resolve into durable
   * cross-assistant state.
   *
   * An absent `origin` is an older cached response and is treated as
   * unattributable for the same reason.
   */
  const ownIds = new Set(
    apps.filter((app) => app.origin === "workspace").map((app) => app.id),
  );
  return legacy
    .filter((pin) => ownIds.has(pin.appId))
    .sort((a, b) => a.pinnedOrder - b.pinnedOrder);
}

export function useLegacyPinMigration(
  assistantId: string | null | undefined,
  isAssistantActive: boolean,
): void {
  const queryClient = useQueryClient();
  const daemonOwnsPins = useSupportsDaemonAppPins();
  /* Platform-mode daemon requests carry `Vellum-Organization-Id` from the org
     store, which hydrates after auth. This hook mounts at the root, so without
     the gate its first request goes out headerless and is rejected, and nothing
     about org hydration would re-run it. */
  const isOrgReady = useIsOrgReady();
  const path = useMemo(
    () => ({ assistant_id: assistantId ?? "" }),
    [assistantId],
  );
  const enabled =
    Boolean(assistantId) && isAssistantActive && daemonOwnsPins && isOrgReady;

  const { data: apps } = useQuery({
    ...appsGetOptions({ path }),
    select: (data) => data.apps,
    enabled,
  });

  const { mutateAsync } = useMutation(appsByIdPinPostMutation());

  /* One attempt per assistant: the app list keeps arriving as it refetches,
     and a second pass would re-read a key this one already drained. */
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    if (!assistantId || !apps || !enabled) {
      return;
    }
    if (attempted.current === assistantId) {
      return;
    }
    attempted.current = assistantId;

    const legacy = loadPinnedApps();
    if (legacy.length === 0) {
      return;
    }
    const claimable = planLegacyPinClaim(legacy, apps);
    if (claimable.length === 0) {
      return;
    }

    void (async () => {
      const claimed = new Set<string>();
      for (const pin of claimable) {
        try {
          await mutateAsync({
            path: { ...path, id: pin.appId },
            body: {
              pinned: true,
              ...(pin.color === undefined ? {} : { color: pin.color }),
            },
          });
          claimed.add(pin.appId);
        } catch {
          // Leave this id in the list so a later load can retry it.
        }
      }
      if (claimed.size === 0) {
        return;
      }
      /* Re-read rather than filtering the snapshot taken before the awaits:
         another assistant's migration may have drained its own entries while
         these claims were in flight, and writing back the stale remainder
         would restore them for it to claim a second time. */
      writeRemaining(loadPinnedApps().filter((pin) => !claimed.has(pin.appId)));
      void queryClient.invalidateQueries({
        queryKey: appsGetQueryKey({ path }),
      });
    })();
  }, [assistantId, apps, enabled, mutateAsync, queryClient, path]);
}
