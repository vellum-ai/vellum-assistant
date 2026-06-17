import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore, type OpenedAppState } from "@/stores/viewer-store";
import {
  getEditChatConversationId,
  setEditChatConversationId,
} from "@/utils/edit-chat-session";
import { routes } from "@/utils/routes";

/**
 * Open an app in the split "edit" view — chat on the left, app on the right —
 * bound to a per-app edit conversation.
 *
 * Resolves (and persists) the edit conversation for this `(assistant, app)`
 * pair so repeated edits land back in the same thread, loads the app into the
 * viewer if it isn't already there, and navigates to that conversation so
 * `ChatMainPanel` renders the `app-editing` split.
 *
 * On a mobile viewport the split layout doesn't fit, so the viewer stays
 * full-screen (`app`) while still binding the edit conversation — matching
 * `useOpenAppFromChat`.
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
      if (!assistantId) return;
      const convId =
        getEditChatConversationId(assistantId, app.appId) ??
        crypto.randomUUID();
      setEditChatConversationId(assistantId, app.appId, convId);

      const viewer = useViewerStore.getState();
      if (viewer.activeAppId !== app.appId || !viewer.openedAppState) {
        viewer.openApp(app.appId);
        viewer.setLoadedApp(app);
      }
      useConversationStore.getState().setEditingConversationId(convId);
      if (!isMobile) viewer.enterAppEditing();

      // The split edit view only renders on the conversation route. Navigate
      // whenever we aren't already there — comparing the path rather than the
      // active conversation id, since off-chat routes (e.g. the Library app
      // view) can still hold a stale matching id without mounting the viewer.
      const target = routes.conversation(convId);
      if (pathname !== target) {
        void navigate(target);
      }
    },
    [assistantId, isMobile, navigate, pathname],
  );
}
