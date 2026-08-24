/**
 * The apps this assistant has pinned to the sidebar, and the actions that
 * change them.
 *
 * Pin state belongs to the assistant and is served by the daemon on the app
 * list itself (`pinnedOrder`, `pinColor`), so a pin is scoped to the assistant
 * that owns the app by construction rather than by a key naming convention.
 * Reading it off the app list also means a pin renders the app's live name and
 * icon, and an app that no longer exists brings no pin with it.
 *
 * Every caller passes the assistant it is showing. There is deliberately no
 * ambient "current assistant" here: the id a pin is written against is the one
 * the calling surface renders, so a pin cannot land on the assistant the user
 * just navigated away from.
 */

import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  appsByIdPinPostMutation,
  appsGetOptions,
  appsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { AppsGetResponse } from "@/generated/daemon/types.gen";
import type { AppSummary } from "@/types/app-types";

export interface PinnedApps {
  /** Pinned apps in sidebar order. Empty until the app list has loaded. */
  pinnedApps: AppSummary[];
  pinnedAppIds: Set<string>;
  isPinned: (appId: string) => boolean;
  togglePin: (appId: string) => void;
  /**
   * Remove a pin by id. A no-op when the id is not pinned. Deleting an app
   * clears its pin daemon-side, so this is not the cleanup path for one whose
   * app is gone: such a pin never reaches the client at all.
   */
  unpin: (appId: string) => void;
  /**
   * Set or clear the colour the sidebar tints this pin with, as an id from the
   * pinned-app colour registry. `null` clears it. A no-op when the id is not
   * pinned, so a colour cannot conjure a pin that unpinning just removed.
   */
  setColor: (appId: string, color: string | null) => void;
}

const EMPTY_APPS: AppSummary[] = [];

export function usePinnedApps(
  assistantId: string | null | undefined,
): PinnedApps {
  const queryClient = useQueryClient();
  /* Memoized because it is a dependency of the write callback, and a fresh
     object each render would rebuild every action on every render. */
  const path = useMemo(
    () => ({ assistant_id: assistantId ?? "" }),
    [assistantId],
  );

  const { data: apps = EMPTY_APPS } = useQuery({
    ...appsGetOptions({ path }),
    select: (data) => data.apps,
    enabled: Boolean(assistantId),
  });

  const pinnedApps = useMemo(
    () =>
      apps
        .filter((app) => app.pinnedOrder !== undefined)
        .sort((a, b) => (a.pinnedOrder ?? 0) - (b.pinnedOrder ?? 0)),
    [apps],
  );

  const pinnedAppIds = useMemo(
    () => new Set(pinnedApps.map((app) => app.id)),
    [pinnedApps],
  );

  const { mutate } = useMutation(appsByIdPinPostMutation());

  const write = useCallback(
    (appId: string, body: { pinned?: boolean; color?: string | null }) => {
      if (!assistantId) {
        return;
      }
      const queryKey = appsGetQueryKey({ path });
      /* Paint the change now and let the daemon confirm it. The write also
         publishes an apps-list invalidation, which is what carries the pin to
         the user's other windows and devices; this only covers the gap before
         that round trip lands. */
      queryClient.setQueryData<AppsGetResponse>(queryKey, (previous) =>
        previous ? applyPin(previous, appId, body) : previous,
      );
      mutate(
        { path: { ...path, id: appId }, body },
        {
          onSettled: () => {
            void queryClient.invalidateQueries({ queryKey });
          },
        },
      );
    },
    [assistantId, mutate, queryClient, path],
  );

  const togglePin = useCallback(
    (appId: string) => {
      write(appId, { pinned: !pinnedAppIds.has(appId) });
    },
    [write, pinnedAppIds],
  );

  const unpin = useCallback(
    (appId: string) => {
      if (!pinnedAppIds.has(appId)) {
        return;
      }
      write(appId, { pinned: false });
    },
    [write, pinnedAppIds],
  );

  const setColor = useCallback(
    (appId: string, color: string | null) => {
      if (!pinnedAppIds.has(appId)) {
        return;
      }
      write(appId, { color });
    },
    [write, pinnedAppIds],
  );

  const isPinned = useCallback(
    (appId: string) => pinnedAppIds.has(appId),
    [pinnedAppIds],
  );

  return { pinnedApps, pinnedAppIds, isPinned, togglePin, unpin, setColor };
}

/**
 * The app list as it will read once the daemon has applied this pin change.
 *
 * Mirrors the daemon's ordering rules rather than guessing: pinning appends
 * after the last pin, unpinning closes the gap it leaves. Only ever the frame
 * before the authoritative list arrives, so a divergence corrects itself.
 */
function applyPin(
  previous: AppsGetResponse,
  appId: string,
  body: { pinned?: boolean; color?: string | null },
): AppsGetResponse {
  const pinnedCount = previous.apps.filter(
    (app) => app.pinnedOrder !== undefined,
  ).length;

  const apps = previous.apps.map((app) => {
    if (app.id !== appId) {
      return app;
    }
    const next: AppSummary = { ...app };
    if (body.pinned === false) {
      delete next.pinnedOrder;
      delete next.pinColor;
      return next;
    }
    if (body.pinned === true && next.pinnedOrder === undefined) {
      next.pinnedOrder = pinnedCount + 1;
    }
    if (body.color === null) {
      delete next.pinColor;
    } else if (body.color !== undefined) {
      next.pinColor = body.color;
    }
    return next;
  });

  const removedOrder =
    body.pinned === false
      ? previous.apps.find((app) => app.id === appId)?.pinnedOrder
      : undefined;
  if (removedOrder === undefined) {
    return { ...previous, apps };
  }
  return {
    ...previous,
    apps: apps.map((app) =>
      app.pinnedOrder !== undefined && app.pinnedOrder > removedOrder
        ? { ...app, pinnedOrder: app.pinnedOrder - 1 }
        : app,
    ),
  };
}
