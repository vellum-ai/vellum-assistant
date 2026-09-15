import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore, type OpenedAppState } from "@/stores/viewer-store";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import {
  getEditChatConversationId,
  setEditChatConversationId,
} from "@/utils/edit-chat-session";
import { appEntryState } from "@/utils/app-navigation";
import { currentPathname } from "@/utils/conversation-navigation";
import { appIdForPath, conversationIdForPath, routes } from "@/utils/routes";

/**
 * Open an app in the split "edit" view — chat on the left, app on the right —
 * bound to a per-app edit conversation.
 *
 * Resolves (and persists) the edit conversation for this `(assistant, app)`
 * pair so repeated edits land back in the same thread, loads the app into the
 * viewer if it isn't already there, and navigates to that conversation's app
 * URL so `ChatMainPanel` renders the `app-editing` split.
 *
 * On a mobile viewport the split layout doesn't fit, so instead the app is
 * minimized to its bottom strip and the edit conversation becomes the primary
 * surface — the user edits by chatting, and the strip reads "Open app". Leaving
 * the app full-screen would re-present the same "Edit" button over a full-screen
 * app, which reads as a no-op (LUM-2809). This is the deliberate difference from
 * `useOpenAppFromChat`, which keeps the app full-screen because it is a
 * view (not edit) action.
 *
 * Shared by the in-chat app viewer (`ChatMainPanel`) and the standalone
 * Library app view (`LibraryDetailPage`).
 */
export function useEditApp(): (app: OpenedAppState) => void {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return useCallback(
    (app) => {
      if (!assistantId) {
        return;
      }
      // The conversation on screen wins, so the pane opens on something the
      // user chose. With nothing on screen, the per-app memo keeps repeated
      // Edit clicks in one thread. A minted id is registered as a draft like
      // every client-minted key, which is what lets the pane paint an empty
      // thread rather than wait on history it does not have. Same order as
      // the document surface in `document-viewer-page`.
      const convId =
        useConversationStore.getState().activeConversationId ??
        getEditChatConversationId(assistantId, app.appId) ??
        createDraftConversationId();
      setEditChatConversationId(assistantId, app.appId, convId);

      // The HTML this caller holds lets `useAppRouteSync` skip a refetch.
      const viewer = useViewerStore.getState();
      if (viewer.activeAppId !== app.appId || !viewer.openedAppState) {
        viewer.openApp(app.appId);
        viewer.setLoadedApp(app);
      }
      useConversationStore.getState().setEditingConversationId(convId);
      if (isMobile) {
        // No room for the chat+app split: land in the edit conversation with
        // the app minimized to its bottom strip so the chat is the primary
        // surface and the strip's affordance reads "Open app" — rather than a
        // second "Edit" button stacked over a re-opened full-screen app.
        viewer.minimizeApp();
      } else {
        viewer.enterAppEditing();
      }

      // The split edit view only renders on the conversation route, and the
      // URL names the app it shows. Navigate whenever we aren't already
      // there. What the path names, read through the parser, because the
      // browser percent-encodes an id the builder writes raw; the path rather
      // than the active conversation id, because off-chat routes (e.g. the
      // Library app view) can hold a stale matching id without mounting the
      // viewer.
      if (
        conversationIdForPath(pathname) !== convId ||
        appIdForPath(pathname) !== app.appId
      ) {
        // Uniform with the view opener, though an Edit lands on its own
        // conversation and so usually records nothing.
        void navigate(routes.conversation(convId, app.appId), {
          state: appEntryState(
            { pathname: currentPathname(), search: "" },
            app.appId,
            convId,
          ),
        });
      }
    },
    [assistantId, isMobile, navigate, pathname],
  );
}
