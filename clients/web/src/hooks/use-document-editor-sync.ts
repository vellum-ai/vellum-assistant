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
 * overlay in `mobile-chat-overlays.tsx`) mount under `ActiveChatView`, which
 * only the conversation chat route renders. Off that route the document is
 * not visible, so its edit is unseen.
 *
 * The standalone `/assistant/documents/:surfaceId` route is not a live surface
 * either: it renders the content it fetched on mount and never applies these
 * updates, so an edit arriving while it is open is unseen there too. That page
 * clears its own record when the user next loads it.
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
} from "@/domains/chat/components/local-file/open-local-file";
import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useViewerStore } from "@/stores/viewer-store";
import { isConversationChatPath } from "@/utils/routes";

/**
 * Subscribes to `document_editor_update` SSE events via the event bus
 * and forwards content updates to the viewer store.
 *
 * Unlike other bus subscribers, this takes no `assistantId` — the viewer
 * store is global and document surface ids are globally unique.
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
