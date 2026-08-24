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
 * left to claim.
 *
 * Two things it deliberately will not do, because a migration that guesses is
 * worse than one that stops:
 *
 * - It never merges into an assistant that already has pins of its own. Those
 *   were chosen after the upgrade, and the legacy list is exactly the state we
 *   distrust.
 * - It never claims an id it cannot find an app for. An unrecognized id is
 *   either another assistant's or a deleted app's, and neither should become a
 *   sidebar row here.
 */

import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  appsByIdPinPostMutation,
  appsGetOptions,
  appsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

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
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isLegacyPin) : [];
  } catch {
    return [];
  }
}

/** Write back what is left to claim, removing the key once nothing is. */
export function writeLegacyPins(pins: LegacyPin[]): void {
  try {
    if (pins.length === 0) {
      localStorage.removeItem(LEGACY_KEY);
      return;
    }
    localStorage.setItem(LEGACY_KEY, JSON.stringify(pins));
  } catch {
    // Storage unavailable. The claim already reached the daemon, and a rerun
    // finds this assistant already pinned and stops at the guard above.
  }
}

/**
 * The entries this assistant should claim from the legacy list, in the order
 * they should be pinned. Empty means claim nothing.
 *
 * Separated from the effect because this is the whole of the migration's
 * judgement, and it is judgement about state we distrust.
 */
export function planLegacyPinClaim(
  legacy: LegacyPin[],
  apps: { id: string; pinnedOrder?: number }[],
): LegacyPin[] {
  // Pins chosen after the upgrade. The legacy list is exactly the state we
  // distrust, so it does not get merged into a list the user has since curated.
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
  const path = useMemo(
    () => ({ assistant_id: assistantId ?? "" }),
    [assistantId],
  );
  const enabled = Boolean(assistantId) && isAssistantActive;

  const { data: apps } = useQuery({
    ...appsGetOptions({ path }),
    select: (data) => data.apps,
    enabled,
  });

  const { mutateAsync } = useMutation(appsByIdPinPostMutation());

  /* One attempt per assistant. The app list keeps arriving as it refetches,
     and a second pass over a list this one just pinned would read its own
     writes as pins the user chose and stop at the guard anyway, but only after
     re-reading a key it already drained. */
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    if (!assistantId || !apps) {
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
      writeLegacyPins(legacy.filter((pin) => !claimed.has(pin.appId)));
      void queryClient.invalidateQueries({
        queryKey: appsGetQueryKey({ path }),
      });
    })();
  }, [assistantId, apps, mutateAsync, queryClient, path]);
}
