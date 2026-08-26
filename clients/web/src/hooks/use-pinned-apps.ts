/**
 * The apps this assistant has pinned to the sidebar, and the actions that
 * change them.
 *
 * Pin state belongs to the assistant and is served by the daemon on the app
 * list itself (`pinSortPosition`, `pinColor`), so a pin is scoped to the
 * assistant that owns the app by construction rather than by a key naming
 * convention. Reading it off the app list also means a pin renders the app's
 * live name and icon, and an app that is gone brings no pin with it.
 *
 * Against a daemon too old to store pins, `use-legacy-pinned-apps.ts` serves
 * instead. The two are alternatives, not layers: one of them owns every pin for
 * the session, and each handles workspace and plugin apps alike. Which one is
 * in play is {@link PinnedApps.source}, and the choice is
 * {@link useSupportsDaemonAppPins}.
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
import type { PinnedAppsBackend, PinnedAppView } from "@/hooks/pinned-apps";
import { useLegacyPinnedApps } from "@/hooks/use-legacy-pinned-apps";
import { useSupportsDaemonAppPins } from "@/lib/backwards-compat/daemon-app-pins";
import type { AppSummary } from "@/types/app-types";

export interface PinnedApps extends PinnedAppsBackend {
  pinnedAppIds: Set<string>;
  /**
   * Which backend served this list. It flips once per load, when the capability
   * resolves, and the list is replaced wholesale when it does. A consumer that
   * reads meaning into the list changing has to treat that swap as a new list
   * rather than as pins going away.
   */
  source: "daemon" | "local";
}

const EMPTY_APPS: AppSummary[] = [];

export function usePinnedApps(
  assistantId: string | null | undefined,
): PinnedApps {
  const daemonOwnsPins = useSupportsDaemonAppPins();
  const path = useMemo(
    () => ({ assistant_id: assistantId ?? "" }),
    [assistantId],
  );

  /* Fetched for both backends: the legacy one needs the app list to resolve the
     name and icon it copies onto a pin. */
  const { data: apps = EMPTY_APPS } = useQuery({
    ...appsGetOptions({ path }),
    select: (data) => data.apps,
    enabled: Boolean(assistantId),
  });

  const daemon = useDaemonPinnedApps(assistantId, path, apps);
  const legacy = useLegacyPinnedApps(apps);
  const backend = daemonOwnsPins ? daemon : legacy;

  const pinnedAppIds = useMemo(
    () => new Set(backend.pinnedApps.map((app) => app.id)),
    [backend.pinnedApps],
  );

  return {
    ...backend,
    pinnedAppIds,
    source: daemonOwnsPins ? "daemon" : "local",
  };
}

function useDaemonPinnedApps(
  assistantId: string | null | undefined,
  path: { assistant_id: string },
  apps: readonly AppSummary[],
): PinnedAppsBackend {
  const queryClient = useQueryClient();

  const pinnedApps = useMemo(
    (): PinnedAppView[] =>
      apps
        .filter((app) => app.pinSortPosition !== undefined)
        .sort((a, b) => (a.pinSortPosition ?? 0) - (b.pinSortPosition ?? 0))
        .map(({ id, name, icon, pinColor }) => ({ id, name, icon, pinColor })),
    [apps],
  );

  const pinnedIds = useMemo(
    () => new Set(pinnedApps.map((app) => app.id)),
    [pinnedApps],
  );

  /*
   * Optimistic through the cache rather than off `mutation.isPending`: pins are
   * toggled from the Library and from an app card, while the sidebar showing
   * them is a different component with its own mutation. The cache is what they
   * share.
   *
   * The daemon publishes an apps-list invalidation on every pin write, which
   * carries the change to the user's other windows and devices. That broadcast
   * suppresses the client that caused it, so `onSettled` settles its own.
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
      write(appId, { pinned: !pinnedIds.has(appId) });
    },
    [write, pinnedIds],
  );

  const unpin = useCallback(
    (appId: string) => {
      if (pinnedIds.has(appId)) {
        write(appId, { pinned: false });
      }
    },
    [write, pinnedIds],
  );

  const setColor = useCallback(
    (appId: string, color: string | null) => {
      if (pinnedIds.has(appId)) {
        write(appId, { color });
      }
    },
    [write, pinnedIds],
  );

  return { pinnedApps, togglePin, unpin, setColor };
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
