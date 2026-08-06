import { useCallback } from "react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { haptic } from "@/utils/haptics";

/**
 * Open an app in the viewer panel from inside the chat surface — sidebar
 * pinned-app click, transcript "Open App" affordance, conversation assets
 * pill.
 *
 * Opening an app is a *view* action, so the app lands full-width:
 * `loadApp` sets `mainView` to `"app"` and nothing here upgrades it. That
 * holds on every viewport, with or without an active conversation, so the
 * app opens the same way from chat as it does from Home / Library rather
 * than the layout depending on the entry point (LUM-2553).
 *
 * Split view (`app-editing`: chat on the left, app on the right) is an
 * explicit choice, never a side effect of opening:
 * - the user picks it through the viewer's "Edit" affordance
 *   (`use-edit-app.ts`), which binds a per-app edit conversation;
 * - the app requests it through `set_view({ view: "split" })`
 *   (`app-viewer-actions.ts`), which binds the active conversation.
 *
 * Both bind `editingConversationId` themselves, and that value is only read
 * while `mainView` is `"app-editing"`, so this hook leaves it alone.
 *
 * Returns a stable async callback `(appId: string) => Promise<void>` safe
 * to drop into deps arrays.
 *
 * Single source of truth, used by `chat-layout.tsx` (sidebar),
 * `chat-route-content.tsx` (transcript) and
 * `use-chat-header-registration.tsx` (assets pill). Don't inline a copy.
 */
export function useOpenAppFromChat(): (appId: string) => Promise<void> {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  return useCallback(
    async (appId: string) => {
      if (!assistantId) {
        return;
      }
      haptic.light();
      await useViewerStore.getState().loadApp(assistantId, appId);
    },
    [assistantId],
  );
}
