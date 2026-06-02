/**
 * Bus consumer for `app_preview_update` SSE events.
 *
 * Live-refreshes the open app preview as the daemon recompiles a multifile
 * app's source. Each successful recompile (`ok`) carries fresh html and a
 * bumped `reloadGeneration`, which swaps the preview iframe; `building` and
 * `error` events update status only and keep the last-good preview visible.
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - stores/viewer-store.ts — app viewer state (`updateOpenedAppPreview`)
 */

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useViewerStore } from "@/stores/viewer-store";

/**
 * Subscribes to `app_preview_update` SSE events via the event bus and forwards
 * the live-build update to the viewer store.
 *
 * Like {@link useDocumentEditorSync}, this takes no `assistantId` — the viewer
 * store is global and app ids are globally unique. The store action no-ops
 * unless the event targets the currently active app.
 */
export function useAppPreviewSync(): void {
  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;
    if (event.type !== "app_preview_update") return;
    useViewerStore.getState().updateOpenedAppPreview(event.appId, {
      html: event.html,
      compileStatus: event.compileStatus,
      buildErrors: event.buildErrors,
      reloadGeneration: event.reloadGeneration,
    });
  });
}
