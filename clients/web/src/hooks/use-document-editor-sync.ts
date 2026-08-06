/**
 * Bus consumer for `document_editor_update` SSE events.
 *
 * Applies streamed document content updates to the viewer store.
 * The daemon sends incremental markdown content (append or replace
 * mode) as the assistant edits a document surface.
 *
 * The same event is also the only signal that a document changed at all, so an
 * edit that lands while the user is not looking at that document is recorded
 * as unseen here. An edit to the document already on screen is not: the user
 * is watching it happen.
 *
 * References:
 * - EVENT_BUS.md: bus subscription contract
 * - stores/viewer-store.ts: document editor state
 * - domains/chat/unseen-document-changes-store.ts: unseen-change records
 */

import { isDocumentOpen } from "@/domains/chat/components/local-file/open-local-file";
import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";
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
    if (event.type !== "document_editor_update") {
      return;
    }
    // An event handler, so the viewer is read rather than subscribed to.
    const viewer = useViewerStore.getState();
    const watchingLive = isDocumentOpen(
      viewer.mainView,
      viewer.openedDocumentState,
      event.surfaceId,
    );
    viewer.updateDocumentContent(event.surfaceId, event.markdown, event.mode);
    if (watchingLive) {
      return;
    }
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged(event.conversationId, event.surfaceId);
  });
}
