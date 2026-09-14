/**
 * The URL names the app on screen, and this hook is the only place that turns
 * that into viewer state. Surfaces open and close an app by navigating to
 * `routes.conversation(conversationId, appId)` or back to the plain
 * conversation URL; nothing else writes `activeAppId`.
 *
 * Split, minimized, and the bound edit conversation stay in memory: they are
 * layout, not identity.
 */

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import { isAppMainView } from "@/stores/pane-state";
import { useConversationStore } from "@/stores/conversation-store";
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
        // The app was hidden behind an overlay and the URL still names it.
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
        // The app loaded but the viewer moved to an overlay mid-request, so
        // the URL still names what the viewer holds.
        return;
      }
      // An app that no longer exists must not stay in the URL, otherwise
      // Forward and reload would retry it forever.
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
