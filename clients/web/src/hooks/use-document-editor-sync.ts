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
 * "On screen" is the route as well as the viewer store. The store keeps
 * `mainView === "document"` and its opened document while the user is away on
 * Library or Settings, but both surfaces that render a document beside the
 * chat (the desktop drawer in `chat-content-layout.tsx` and the mobile
 * document region in `chat-route-content.tsx`) mount under `ActiveChatView`, which
 * only the conversation chat route renders. Off that route the document is
 * not visible, so its edit is unseen.
 *
 * On mobile, `/assistant/documents/:surfaceId` opens the linked chat session.
 * Its desktop standalone viewer renders its fetched content, so an edit arriving
 * there is unseen until the next load. The document route and presentation
 * helpers clear their own records when a document is shown.
 *
 * Returning to the chat route puts a still-open document back on screen with
 * no load of its own to clear the record it collected while away, so that
 * clearing happens here too.
 *
 * References:
 * - EVENT_BUS.md: bus subscription contract
 * - stores/viewer-store.ts: document editor state
 * - domains/chat/unseen-document-changes-store.ts: unseen-change records
 */

import { useEffect } from "react";
import { useLocation } from "react-router";

import {
  isDocumentOpen,
  openedDocumentSurfaceId,
} from "@/components/local-file/open-local-file";
import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useViewerStore } from "@/stores/viewer-store";
import { isConversationChatPath } from "@/utils/routes";

/**
 * Subscribes to `document_editor_update` SSE events via the event bus
 * and forwards content updates to the viewer store.
 *
 * This consumes the selected assistant's event stream and updates the global
 * viewer store.
 */
export function useDocumentEditorSync(): void {
  const location = useLocation();
  const chatVisible = isConversationChatPath(location.pathname);

  useEffect(() => {
    if (!chatVisible) {
      return;
    }
    const viewer = useViewerStore.getState();
    const surfaceId = openedDocumentSurfaceId(
      viewer.mainView,
      viewer.openedDocumentState,
    );
    if (surfaceId === null) {
      return;
    }
    useUnseenDocumentChangesStore.getState().clearDocumentEverywhere(surfaceId);
  }, [chatVisible]);

  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;
    if (event.type !== "document_editor_update") {
      return;
    }
    // An event handler, so the viewer is read rather than subscribed to.
    const viewer = useViewerStore.getState();
    const watchingLive =
      chatVisible &&
      isDocumentOpen(
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
