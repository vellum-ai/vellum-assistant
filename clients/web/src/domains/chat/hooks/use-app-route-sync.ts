/**
 * The URL segment `app/:appId` names the app on screen: this hook loads it
 * when the viewer does not already hold it, brings it back in front when an
 * overlay holds the main view, and drops the segment from the URL when the app
 * cannot be loaded. A conversation URL without the segment names no app, so
 * this hook closes one the viewer still holds.
 */

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import { useConversationStore } from "@/stores/conversation-store";
import { isAppMainView } from "@/stores/pane-state";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

export function useAppRouteSync(
  assistantId: string | null,
  conversationId: string | null,
  routeAppId: string | null,
): void {
  const navigate = useNavigate();
  // Read through a ref so switching conversation beside an open app does not
  // re-run the effect and reload the app.
  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    const viewer = useViewerStore.getState();

    if (routeAppId === null) {
      if (viewer.activeAppId !== null || isAppMainView(viewer.mainView)) {
        viewer.closeApp();
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
      if (useViewerStore.getState().activeAppId === routeAppId) {
        // The viewer holds the app behind an overlay, so the URL still names
        // what the viewer holds.
        return;
      }
      // An app id the viewer cannot load does not belong in the URL, where
      // reload and Forward would retry it forever.
      const cid = conversationIdRef.current;
      if (cid) {
        void navigate(routes.conversation(cid), { replace: true });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [assistantId, routeAppId, navigate]);
}
