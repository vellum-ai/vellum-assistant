/**
 * Opening one of a conversation's surfaces in the viewer panel: an app through
 * {@link openAppFromChat}, a document through {@link openDocumentFromChat}.
 * Both buzz and hand off to the viewer store, so every entry point into the
 * viewer from chat feels the same. {@link useOpenAppFromChat} binds the app
 * helper to the active assistant, for the surfaces that do not name one.
 */

import { useCallback } from "react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { haptic } from "@/utils/haptics";

/** Opens `appId` under `assistantId` in the viewer panel. */
export async function openAppFromChat(
  assistantId: string,
  appId: string,
): Promise<void> {
  haptic.light();
  await useViewerStore.getState().loadApp(assistantId, appId);
}

/** Opens the document `surfaceId` under `assistantId` in the viewer panel. */
export async function openDocumentFromChat(
  assistantId: string,
  surfaceId: string,
): Promise<void> {
  haptic.light();
  await useViewerStore.getState().loadDocument(assistantId, surfaceId);
}

/**
 * Open an app in the viewer panel from inside the chat surface: the sidebar's
 * pinned-app click and the transcript's "Open App" affordance.
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
 * - the user selects a conversation while an app is already open
 *   (`keepOpenAppBesideConversation`), which binds that conversation;
 * - the app requests it through `set_view({ view: "split" })`
 *   (`app-viewer-actions.ts`), which binds the active conversation.
 *
 * Those paths bind `editingConversationId` themselves, and that value is only
 * read while `mainView` is `"app-editing"`, so this hook leaves it alone.
 *
 * Returns a stable async callback `(appId: string) => Promise<void>` safe
 * to drop into deps arrays.
 *
 * Single source of truth for the active assistant's apps, used by
 * `chat-layout.tsx` (sidebar) and `chat-route-content.tsx` (transcript).
 * Don't inline a copy. A surface that opens an app for some other assistant
 * (the chat-info panel opens the one its payload names) calls
 * {@link openAppFromChat} with that assistant.
 */
export function useOpenAppFromChat(): (appId: string) => Promise<void> {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  return useCallback(
    async (appId: string) => {
      if (!assistantId) {
        return;
      }
      await openAppFromChat(assistantId, appId);
    },
    [assistantId],
  );
}
