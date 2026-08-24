/**
 * The apps this assistant has pinned to the sidebar, and the actions that
 * change them.
 *
 * Pin state belongs to the assistant and is served by the daemon on the app
 * list itself (`pinSortPosition`, `pinColor`), so a pin is scoped to the
 * assistant that owns the app by construction rather than by a key naming
 * convention. Reading it off the app list also means a pin renders the app's
 * live name and icon, and an app that no longer exists brings no pin with it.
 *
 * Against a daemon too old to store pins, this falls back wholesale to the
 * browser-local list it used to keep (`utils/app-pin-storage.ts`, legacy). The
 * two paths are alternatives, not layers: one of them owns every pin for the
 * session, and each handles workspace and plugin apps alike. Which one is in
 * play is {@link PinnedApps.source}. See {@link useSupportsDaemonAppPins}.
 *
 * Every caller passes the assistant it is showing. There is deliberately no
 * ambient "current assistant" here: the id a pin is written against is the one
 * the calling surface renders, so a pin cannot land on the assistant the user
 * just navigated away from.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  appsByIdPinPostMutation,
  appsGetOptions,
  appsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { AppsGetResponse } from "@/generated/daemon/types.gen";
import { useSupportsDaemonAppPins } from "@/lib/backwards-compat/daemon-app-pins";
import type { AppSummary } from "@/types/app-types";
import {
  loadPinnedApps,
  pinApp,
  setAppColor,
  subscribePinnedApps,
  unpinApp,
} from "@/utils/app-pin-storage";

/**
 * What a pinned row renders from. Narrower than the full {@link AppSummary}
 * because the legacy path can supply only these four fields, and because a
 * sidebar row has no use for an app's provenance or timestamps.
 */
export type PinnedAppView = Pick<
  AppSummary,
  "id" | "name" | "icon" | "pinColor"
>;

export interface PinnedApps {
  /** Pinned apps in sidebar order. Empty until the app list has loaded. */
  pinnedApps: PinnedAppView[];
  pinnedAppIds: Set<string>;
  /**
   * Where this list came from. It flips once per load, when the daemon version
   * hydrates and the gate resolves, and the list is replaced wholesale when it
   * does. A consumer that reads meaning into the list changing has to treat
   * that swap as a new list rather than as pins going away.
   */
  source: "daemon" | "local";
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
  const daemonOwnsPins = useSupportsDaemonAppPins();
  const queryClient = useQueryClient();
  const path = useMemo(
    () => ({ assistant_id: assistantId ?? "" }),
    [assistantId],
  );

  /* Fetched on both paths: the legacy one still needs the app list to resolve
     the name and icon it copies onto a pin. */
  const { data: apps = EMPTY_APPS } = useQuery({
    ...appsGetOptions({ path }),
    select: (data) => data.apps,
    enabled: Boolean(assistantId),
  });

  const legacyEntries = useSyncExternalStore(
    subscribePinnedApps,
    loadPinnedApps,
    loadPinnedApps,
  );

  const pinnedApps = useMemo((): PinnedAppView[] => {
    if (daemonOwnsPins) {
      return apps
        .filter((app) => app.pinSortPosition !== undefined)
        .sort((a, b) => (a.pinSortPosition ?? 0) - (b.pinSortPosition ?? 0))
        .map(({ id, name, icon, pinColor }) => ({ id, name, icon, pinColor }));
    }
    return [...legacyEntries]
      .sort((a, b) => a.pinnedOrder - b.pinnedOrder)
      .map((entry) => ({
        id: entry.appId,
        name: entry.name,
        icon: entry.icon,
        pinColor: entry.color,
      }));
  }, [daemonOwnsPins, apps, legacyEntries]);

  const pinnedAppIds = useMemo(
    () => new Set(pinnedApps.map((app) => app.id)),
    [pinnedApps],
  );

  /*
   * Optimistic through the cache rather than off `mutation.isPending`: pins are
   * toggled from the Library and from an app card, and the sidebar showing them
   * is a different component with a different mutation. The cache is what all
   * of them share.
   *
   * The daemon publishes an apps-list invalidation on every pin write, which is
   * what carries the change to the user's other windows and devices. That
   * broadcast suppresses the client that caused it, so `onSettled` settles its
   * own.
   */
  const { mutate } = useMutation({
    ...appsByIdPinPostMutation(),
    onMutate: async (variables) => {
      const queryKey = appsGetQueryKey({ path });
      /* A refetch already in flight would otherwise resolve after this write
         and put the pre-pin list back. */
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<AppsGetResponse>(queryKey);
      queryClient.setQueryData<AppsGetResponse>(queryKey, (current) =>
        current
          ? applyPin(current, variables.path.id, variables.body)
          : current,
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(appsGetQueryKey({ path }), context.previous);
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: appsGetQueryKey({ path }) }),
  });

  const write = useCallback(
    (appId: string, body: { pinned?: boolean; color?: string | null }) => {
      if (assistantId) {
        mutate({ path: { ...path, id: appId }, body });
      }
    },
    [assistantId, mutate, path],
  );

  const togglePin = useCallback(
    (appId: string) => {
      const pinned = pinnedAppIds.has(appId);
      if (daemonOwnsPins) {
        write(appId, { pinned: !pinned });
        return;
      }
      if (pinned) {
        unpinApp(appId);
        return;
      }
      const app = apps.find((candidate) => candidate.id === appId);
      if (app) {
        pinApp({ id: app.id, name: app.name, icon: app.icon });
      }
    },
    [daemonOwnsPins, write, pinnedAppIds, apps],
  );

  const unpin = useCallback(
    (appId: string) => {
      if (!pinnedAppIds.has(appId)) {
        return;
      }
      if (daemonOwnsPins) {
        write(appId, { pinned: false });
      } else {
        unpinApp(appId);
      }
    },
    [daemonOwnsPins, write, pinnedAppIds],
  );

  const setColor = useCallback(
    (appId: string, color: string | null) => {
      if (!pinnedAppIds.has(appId)) {
        return;
      }
      if (daemonOwnsPins) {
        write(appId, { color });
      } else {
        setAppColor(appId, color);
      }
    },
    [daemonOwnsPins, write, pinnedAppIds],
  );

  return {
    pinnedApps,
    pinnedAppIds,
    source: daemonOwnsPins ? "daemon" : "local",
    togglePin,
    unpin,
    setColor,
  };
}

/**
 * The app list as it will read once the daemon has applied this pin change.
 *
 * Positions are a fractional index, so a pin appends past the last one and an
 * unpin leaves every survivor where it was. Nothing here has to renumber.
 */
function applyPin(
  current: AppsGetResponse,
  appId: string,
  body: { pinned?: boolean; color?: string | null },
): AppsGetResponse {
  const lastPosition = current.apps.reduce(
    (highest, app) => Math.max(highest, app.pinSortPosition ?? 0),
    0,
  );
  return {
    ...current,
    apps: current.apps.map((app) => {
      if (app.id !== appId) {
        return app;
      }
      const next: AppSummary = { ...app };
      if (body.pinned === false) {
        delete next.pinSortPosition;
        delete next.pinColor;
        return next;
      }
      if (body.pinned === true && next.pinSortPosition === undefined) {
        next.pinSortPosition = lastPosition + 1;
      }
      if (body.color === null) {
        delete next.pinColor;
      } else if (body.color !== undefined) {
        next.pinColor = body.color;
      }
      return next;
    }),
  };
}
