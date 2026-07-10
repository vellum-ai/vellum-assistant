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
 * Always navigates to the assistant index (`routes.assistant`) when off-chat.
 * Routing to the last active conversation would surface a stale conversation
 * in the split view (LUM-2691): `activeConversationId` is intentionally left
 * intact across route changes for SSE / attention / reconciliation consumers,
 * so it does not reflect the user's current intent.
 *
 * Exported so the sidebar caller in `chat-layout.tsx` can unit-test the
 * route detection without a full React Router harness.
 */
export function chooseSidebarOpenAppDestination(
  pathname: string,
): string | null {
  if (isConversationChatPath(pathname)) {
    return null;
  }
  return routes.assistant;
}

export interface UseOpenAppFromChatOptions {
  /**
   * When `true` (default), bind the active conversation as the app-editing
   * target and enter `app-editing` split view on wide viewports. When
   * `false`, skip both — the app opens in full-screen `app` mode with no
   * conversation bound. The sidebar caller sets this to `false` when the
   * user is not on a chat route, so a pinned-app click from home / library
   * / identity doesn't surface a stale conversation (LUM-2691).
   */
  bindConversation?: boolean;
}

export function useOpenAppFromChat(
  options?: UseOpenAppFromChatOptions,
): (appId: string) => Promise<void> {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const isMobile = useIsMobile();
  const bindConversation = options?.bindConversation ?? true;

  return useCallback(
    async (appId: string) => {
      if (!assistantId) {
        return;
      }
      haptic.light();
      await useViewerStore.getState().loadApp(assistantId, appId);
      const { activeAppId, openedAppState } = useViewerStore.getState();
      if (bindConversation && activeConversationId && openedAppState && activeAppId === appId) {
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
    [assistantId, activeConversationId, isMobile, bindConversation],
  );
}
