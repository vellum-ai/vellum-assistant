/**
 * The URL segment `app/:appId` names the app on screen: this hook loads it
 * when the viewer does not already hold it, brings it back in front when an
 * overlay holds the main view, and drops the segment from the URL when the app
 * cannot be loaded. A conversation URL without the segment names no app, so
 * this hook lets go of one the viewer still holds.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router";

import { useConversationStore } from "@/stores/conversation-store";
import { isAppMainView } from "@/stores/pane-state";
import { useViewerStore } from "@/stores/viewer-store";
import {
  clearAppViewer,
  dropAppFromRoute,
} from "@/utils/conversation-navigation";

export function useAppRouteSync(
  assistantId: string | null,
  routeAppId: string | null,
): void {
  const navigate = useNavigate();

  useEffect(() => {
    const viewer = useViewerStore.getState();

    if (routeAppId === null) {
      if (isAppMainView(viewer.mainView)) {
        clearAppViewer();
      } else if (viewer.activeAppId !== null) {
        // This hook runs after the child effect that opened an overlay over
        // the app, so closing would pull the view out from under it.
        viewer.releaseApp();
        useConversationStore.getState().setEditingConversationId(null);
      }
      return;
    }
    if (!assistantId) {
      return;
    }

    if (
      viewer.activeAppId === routeAppId &&
      viewer.openedAppState?.appId === routeAppId
    ) {
      if (!isAppMainView(viewer.mainView)) {
        viewer.setMainView("app");
      }
      return;
    }

    if (viewer.activeAppId === routeAppId) {
      // A load is already in flight, or `useEditApp` pre-seeded this app.
      return;
    }

    let cancelled = false;
    void viewer.loadApp(assistantId, routeAppId).then((loaded) => {
      if (loaded || cancelled) {
        return;
      }
      dropAppFromRoute(navigate, routeAppId);
    });
    return () => {
      cancelled = true;
    };
  }, [assistantId, routeAppId, navigate]);
}
