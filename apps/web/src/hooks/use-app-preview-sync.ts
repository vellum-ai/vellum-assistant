/**
 * Bus consumer for `app_preview_update` SSE events.
 *
 * Two responsibilities, both driven off the daemon's live-build stream:
 *
 * 1. **Hot-reload the open preview** — forward every event to
 *    `updateOpenedAppPreview`, which swaps the iframe on a successful
 *    recompile and surfaces a build-error badge otherwise (PR 3). That
 *    action no-ops unless the event targets the currently active app.
 * 2. **Auto-open the split-view** — when a build begins for an app that
 *    is NOT currently open, pop open the desktop chat-left / preview-right
 *    panel (`revealAppForBuild`) so the user watches it build side-by-side
 *    (Lovable-style). Desktop-only; gated on the active assistant.
 *
 * Assistant/conversation gating: the bus-owned SSE connection is
 * assistant-scoped (`sseService.attach(assistantId)` is re-attached when
 * the active assistant changes), so every `sse.event` already belongs to
 * the currently-active assistant — there is no `assistantId` on the
 * `app_preview_update` payload to filter on. We additionally gate on the
 * caller-supplied active `assistantId` + `isAssistantActive` (the same
 * pattern as `useConversationSync`) so a background/transitioning
 * assistant never yanks a panel open, and so we have the id `loadApp`
 * needs. The envelope's `conversationId` becomes the edit-chat target so
 * the desktop `app-editing` branch (which requires `editingConversationId`)
 * actually renders for the conversation the user is viewing.
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - hooks/use-conversation-sync.ts — the active-assistant gating pattern
 * - stores/viewer-store.ts — app viewer state + `revealAppForBuild`
 */

import { useRef } from "react";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore, type AppCompileStatus } from "@/stores/viewer-store";

interface UseAppPreviewSyncParams {
  /** Active assistant id (owner of the bus SSE connection). */
  assistantId: string | null;
  /** Whether that assistant is in the `active` lifecycle phase. */
  isAssistantActive: boolean;
  /**
   * Mobile viewport. On mobile the desktop split-view doesn't exist, so we
   * never force it open — the existing `MobileAppOverlay` path is unchanged.
   */
  isMobile: boolean;
}

/**
 * Subscribes to `app_preview_update` SSE events via the event bus,
 * forwards the live-build update to the open preview, and auto-opens the
 * side-by-side panel when a build begins for a not-yet-open app.
 */
export function useAppPreviewSync({
  assistantId,
  isAssistantActive,
  isMobile,
}: UseAppPreviewSyncParams): void {
  // Last seen compile status per app, so we can detect when a *fresh*
  // build sequence begins (first event, or a `building` that follows a
  // terminal `ok`/`error`). A ref — this is per-event bookkeeping, not
  // render-visible state.
  const lastStatusByApp = useRef(new Map<string, AppCompileStatus>());

  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;
    if (event.type !== "app_preview_update") return;

    const viewer = useViewerStore.getState();

    // The live-build fields this event contributes, used both to hot-reload
    // the open preview and to seed an auto-opened one.
    const preview = {
      html: event.html,
      compileStatus: event.compileStatus,
      buildErrors: event.buildErrors,
      reloadGeneration: event.reloadGeneration,
    };

    // (1) Hot-reload the open preview (no-ops unless this is the active app).
    viewer.updateOpenedAppPreview(event.appId, preview);

    // (2) Auto-open the split-view for a build that just started.
    //
    // A fresh build sequence: the first `building` event we've seen for this
    // app, or a `building` event that follows a terminal status. This is the
    // ONLY signal that may auto-open the panel — terminal `ok`/`error` events
    // must never reveal it. Otherwise, if the user navigates away to a
    // document/tool-detail/other view mid-build, the terminal event for the
    // same build would yank them back into `app-editing`.
    const prevStatus = lastStatusByApp.current.get(event.appId);
    lastStatusByApp.current.set(event.appId, event.compileStatus);
    if (event.compileStatus !== "building") return;
    const isFreshBuildStart =
      prevStatus === undefined ||
      prevStatus === "ok" ||
      prevStatus === "error";
    if (!isFreshBuildStart) return;
    // Reset a prior user dismissal so this fresh build re-opens the panel.
    viewer.clearBuildDismissal(event.appId);

    // Mobile keeps the existing overlay path — don't force the split.
    // Gate on the active assistant so a background/transitioning assistant
    // never yanks a panel open.
    if (isMobile || !assistantId || !isAssistantActive) return;
    // Bail early when `revealAppForBuild` would no-op anyway — the user is
    // already viewing this app, or dismissed it for the current build — so
    // we don't disturb their edit-chat target. Mirrors the store guards.
    // Re-read state here: `clearBuildDismissal` above may have just cleared
    // the flag, and the `viewer` snapshot taken earlier would be stale.
    const current = useViewerStore.getState();
    const alreadyViewing =
      current.activeAppId === event.appId &&
      (current.mainView === "app" || current.mainView === "app-editing");
    if (alreadyViewing || current.dismissedBuildAppId === event.appId) return;
    // Set the edit-chat target to the conversation driving this build so
    // the desktop `app-editing` branch renders. Fall back to the active
    // conversation when the envelope omits it.
    const conversationId =
      envelope.conversationId ??
      useConversationStore.getState().activeConversationId;
    if (conversationId) {
      useConversationStore.getState().setEditingConversationId(conversationId);
    }
    // Seed the opened state with the build event's last-good html so the
    // newly opened preview shows the last working version immediately. The
    // store's fetch races the in-progress compile (which deletes `dist/`) and
    // can otherwise resolve the "App compilation failed" placeholder.
    current.revealAppForBuild(assistantId, event.appId, preview);
  });
}
