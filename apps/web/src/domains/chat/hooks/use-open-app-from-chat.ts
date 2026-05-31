import { useCallback } from "react";

import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { haptic } from "@/utils/haptics";

/**
 * Open an app in the viewer panel from inside the chat surface — sidebar
 * pinned-app click, transcript "Open App" affordance, conversation assets
 * pill. When there's an active conversation, transition the viewer to
 * `app-editing` (split view: chat on the left, app on the right) and bind
 * the chat as the editing target. When there isn't, just `app` view.
 *
 * Returns a stable async callback `(appId: string) => Promise<void>` safe
 * to drop into deps arrays.
 *
 * Single source of truth — used by `chat-layout.tsx` (sidebar) and
 * `chat-page.tsx` (transcript). Don't inline a copy.
 */
export function useOpenAppFromChat(): (appId: string) => Promise<void> {
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();
  const activeConversationId = useConversationStore.use.activeConversationId();

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
        useViewerStore.getState().enterAppEditing();
      }
    },
    [assistantId, activeConversationId],
  );
}
