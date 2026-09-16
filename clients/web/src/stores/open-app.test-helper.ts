/**
 * An app on screen, seeded the way a route puts it there.
 *
 * `keptAppId()` and the navigators built on it read two sources: the viewer
 * store for the app loaded, and `window.location` for the route that named
 * it. An app seeded into one without the other is on screen for neither, so
 * a suite that sets the store alone silently exercises the closed case.
 * Seeding both together is the whole job of this module.
 */

import { useViewerStore, type OpenedAppState } from "@/stores/viewer-store";
import type { AppEntryState } from "@/utils/app-navigation";
import { routes } from "@/utils/routes";

/** The app the viewer holds. */
export const SAMPLE_APP: OpenedAppState = {
  assistantId: "asst-1",
  appId: "app-1",
  name: "My App",
  html: "<h1>hi</h1>",
};

/**
 * Put the window on `path`, which the imperative route helpers read. `state` is
 * the entry's own history state, which React Router keeps under `usr`.
 */
export function showPath(path: string, state?: unknown): void {
  window.history.replaceState(
    state === undefined ? null : { usr: state },
    "",
    path,
  );
}

/**
 * Show {@link SAMPLE_APP} on `conversationId`'s route, the shape a wide
 * viewport keeps beside the chat: loaded in the viewer, and named by the URL.
 * `entryState` seeds what the entry records, for a caller that reads it.
 */
export function showOpenAppRoute({
  conversationId,
  mainView = "app",
  entryState,
}: {
  conversationId: string;
  mainView?: "app" | "app-editing";
  entryState?: unknown;
}): void {
  useViewerStore.setState({
    mainView,
    activeAppId: SAMPLE_APP.appId,
    openedAppState: SAMPLE_APP,
  });
  showPath(routes.conversation(conversationId, SAMPLE_APP.appId), entryState);
}

/** The history state an open from `conversationId` records on its entry. */
export function appEntryStateFor(
  conversationId: string,
  appId: string = SAMPLE_APP.appId,
): AppEntryState {
  return {
    appEntry: { appId, returnTo: routes.conversation(conversationId) },
  };
}
