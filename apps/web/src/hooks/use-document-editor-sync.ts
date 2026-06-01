/**
 * Bus consumer for `document_editor_update` SSE events.
 *
 * Applies streamed document content updates to the viewer store.
 * The daemon sends incremental markdown content (append or replace
 * mode) as the assistant edits a document surface.
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - stores/viewer-store.ts — document editor state
 */

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useViewerStore } from "@/stores/viewer-store";

/**
 * Subscribes to `document_editor_update` SSE events via the event bus
 * and forwards content updates to the viewer store.
 *
 * Unlike other bus subscribers, this takes no `assistantId` — the viewer
 * store is global and document surface ids are globally unique.
 */
export function useDocumentEditorSync(): void {
  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;
    if (event.type !== "document_editor_update") return;
    useViewerStore
      .getState()
      .updateDocumentContent(event.surfaceId, event.markdown, event.mode);
  });
}
