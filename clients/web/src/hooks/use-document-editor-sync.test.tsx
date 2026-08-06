/**
 * `useDocumentEditorSync` applies a streamed document edit to the viewer and
 * records the change as unseen unless the user is watching that very document.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";
import { useDocumentEditorSync } from "@/hooks/use-document-editor-sync";
import { __resetForTesting, publish } from "@/lib/event-bus";
import { useViewerStore } from "@/stores/viewer-store";

function publishDocumentEdit(options: {
  conversationId?: string;
  surfaceId: string;
  markdown?: string;
}) {
  act(() => {
    publish("sse.event", {
      id: "evt-1",
      emittedAt: new Date().toISOString(),
      message: {
        type: "document_editor_update",
        conversationId: options.conversationId ?? "conv-1",
        surfaceId: options.surfaceId,
        markdown: options.markdown ?? "# Edited",
        mode: "replace",
      },
    });
  });
}

/** Put the in-chat viewer on `surfaceId`, the way `loadDocument` leaves it. */
function openInViewer(surfaceId: string) {
  useViewerStore.getState().openDocument();
  useViewerStore.getState().setLoadedDocument({
    source: "document",
    surfaceId,
    conversationId: "conv-1",
    documentName: "Notes",
    content: "# Notes",
  });
}

function unseenFor(conversationId: string): string[] {
  const changed =
    useUnseenDocumentChangesStore.getState().changedDocuments[conversationId];
  return [...(changed ?? [])];
}

beforeEach(() => {
  __resetForTesting();
  useViewerStore.getState().reset();
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useDocumentEditorSync", () => {
  test("records an unseen change when the document is not open", () => {
    renderHook(() => useDocumentEditorSync());

    publishDocumentEdit({ surfaceId: "surf-1" });

    expect(unseenFor("conv-1")).toEqual(["surf-1"]);
  });

  test("records nothing when that document is the one on screen", () => {
    openInViewer("surf-1");
    renderHook(() => useDocumentEditorSync());

    publishDocumentEdit({ surfaceId: "surf-1" });

    expect(unseenFor("conv-1")).toEqual([]);
  });

  test("records an unseen change when a different document is on screen", () => {
    openInViewer("surf-1");
    renderHook(() => useDocumentEditorSync());

    publishDocumentEdit({ surfaceId: "surf-2" });

    expect(unseenFor("conv-1")).toEqual(["surf-2"]);
  });

  test("records against the conversation the edit came from", () => {
    renderHook(() => useDocumentEditorSync());

    publishDocumentEdit({ conversationId: "conv-2", surfaceId: "surf-1" });

    expect(unseenFor("conv-1")).toEqual([]);
    expect(unseenFor("conv-2")).toEqual(["surf-1"]);
  });

  test("applies the streamed content to the open document", () => {
    openInViewer("surf-1");
    renderHook(() => useDocumentEditorSync());

    publishDocumentEdit({ surfaceId: "surf-1", markdown: "# Rewritten" });

    expect(useViewerStore.getState().openedDocumentState).toMatchObject({
      surfaceId: "surf-1",
      content: "# Rewritten",
    });
  });
});
