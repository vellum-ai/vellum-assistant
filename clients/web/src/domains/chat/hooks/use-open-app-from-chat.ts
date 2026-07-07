import { useCallback } from "react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { haptic } from "@/utils/haptics";
import { isConversationChatPath, routes } from "@/utils/routes";

/**
 * Open an app in the viewer panel from inside the chat surface — sidebar
 * pinned-app click, transcript "Open App" affordance, conversation assets
 * pill.
 *
 * On a wide viewport (`md` and up), when there's an active conversation,
 * transition the viewer to `app-editing` (split view: chat on the left,
 * app on the right) and bind the chat as the editing target. On a mobile
 * viewport (`max-width: 767px`) the split layout doesn't fit horizontally,
 * so we leave the viewer in `app` mode (full-screen app) — the editing
 * conversation is still bound so any subsequent "edit this app" affordance
 * threads back to the correct conversation.
 *
 * Returns a stable async callback `(appId: string) => Promise<void>` safe
 * to drop into deps arrays.
 *
 * Single source of truth — used by `chat-layout.tsx` (sidebar) and
 * `chat-page.tsx` (transcript). Don't inline a copy.
 */
/**
 * Decide the route to navigate to before opening an app from the sidebar.
 * The viewer panel only renders under `ChatPage` (the routes matched by
 * `isConversationChatPath`). From any other route (home, library, identity,
 * inspector, …) the viewer-store mutation would have no surface to display
 * against, so we have to navigate first.
 *
 * Returns `null` when the caller is already on a route that mounts the
 * viewer — no navigation needed.
 *
 * Exported so the sidebar caller in `chat-layout.tsx` can unit-test the
 * route detection without a full React Router harness.
 */
export function chooseSidebarOpenAppDestination(
  pathname: string,
  activeConversationId: string | null,
): string | null {
  if (isConversationChatPath(pathname)) return null;
  return activeConversationId
    ? routes.conversation(activeConversationId)
    : routes.assistant;
}

export function useOpenAppFromChat(): (appId: string) => Promise<void> {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const isMobile = useIsMobile();

  return useCallback(
    async (appId: string) => {
      if (!assistantId) return;
      haptic.light();
      await useViewerStore.getState().loadApp(assistantId, appId);
      const { activeAppId, openedAppState } = useViewerStore.getState();
      if (activeConversationId && openedAppState && activeAppId === appId) {
        useConversationStore
          .getState()
          .setEditingConversationId(activeConversationId);
        // Mobile viewports can't fit the split chat+app layout. `loadApp`
        // already left `mainView` at `"app"` (full-screen), so we simply
        // skip the upgrade to `"app-editing"`.
        if (!isMobile) {
          useViewerStore.getState().enterAppEditing();
        }
      }
    },
    [assistantId, activeConversationId, isMobile],
  );
}
