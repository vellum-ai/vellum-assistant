/**
 * Hand the browser's old pinned-app list to the daemon, once per assistant.
 *
 * Pins used to live in a single `vellum:pinnedApps` key for the whole browser
 * profile, shared by every assistant. That is the defect this migration exists
 * to clean up, and it makes the stored list a union of pins from every
 * assistant the user ever opened, with nothing in it saying which pin belonged
 * to which.
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
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";

const LEGACY_KEY = "vellum:pinnedApps";

export interface LegacyPin {
  appId: string;
  pinnedOrder: number;
  color?: string;
}

function isLegacyPin(value: unknown): value is LegacyPin {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.appId === "string" &&
    record.appId.length > 0 &&
    typeof record.pinnedOrder === "number" &&
    Number.isFinite(record.pinnedOrder) &&
    (record.color === undefined || typeof record.color === "string")
  );
}

/** The legacy list, malformed entries dropped. Empty when the key is gone. */
export function readLegacyPins(): LegacyPin[] {
  const raw = getLocalSetting(LEGACY_KEY, "");
  if (raw === "") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isLegacyPin) : [];
  } catch {
    return [];
  }
}

/**
 * Write back what is left to claim, removing the key once nothing is.
 *
 * A rejected write is not retried: the claim it follows already reached the
 * daemon, so the next load reads this assistant as pinned and stops at the
 * guard in {@link planLegacyPinClaim}.
 */
export function writeLegacyPins(pins: LegacyPin[]): void {
  if (pins.length === 0) {
    removeLocalSetting(LEGACY_KEY);
    return;
  }
  setLocalSetting(LEGACY_KEY, JSON.stringify(pins));
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
  legacy: LegacyPin[],
  apps: { id: string; pinnedOrder?: number }[],
): LegacyPin[] {
  if (apps.some((app) => app.pinnedOrder !== undefined)) {
    return [];
  }
  const ownIds = new Set(apps.map((app) => app.id));
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

    const legacy = readLegacyPins();
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
      writeLegacyPins(readLegacyPins().filter((pin) => !claimed.has(pin.appId)));
      void queryClient.invalidateQueries({
        queryKey: appsGetQueryKey({ path }),
      });
    })();
  }, [assistantId, apps, enabled, mutateAsync, queryClient, path]);
}
