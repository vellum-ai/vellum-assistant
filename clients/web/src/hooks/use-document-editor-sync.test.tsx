/**
 * `useDocumentEditorSync` applies a streamed document edit to the viewer and
 * records the change as unseen unless the user is watching that very document.
 *
 * "Watching" is the route as well as the viewer store, so these render the
 * hook under a router positioned on the route being exercised.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";

import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";
import { useDocumentEditorSync } from "@/hooks/use-document-editor-sync";
import { __resetForTesting, publish } from "@/lib/event-bus";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

/** Drives the router from a test, since `MemoryRouter` ignores entry changes. */
let navigate: NavigateFunction | null = null;

function NavigationProbe() {
  const navigateFn = useNavigate();
  useEffect(() => {
    navigate = navigateFn;
  }, [navigateFn]);
  return null;
}

/** Mount the hook on `pathname`, defaulting to the conversation chat route. */
function renderSyncAt(pathname: string = routes.conversation("conv-1")) {
  return renderHook(() => useDocumentEditorSync(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[pathname]}>
        <NavigationProbe />
        {children}
      </MemoryRouter>
    ),
  });
}

/** Navigate the mounted router, the way a click in the sidebar would. */
function navigateTo(pathname: string) {
  act(() => {
    navigate?.(pathname);
  });
}

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
  navigate = null;
  useViewerStore.getState().reset();
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useDocumentEditorSync", () => {
  test("records an unseen change when the document is not open", () => {
    renderSyncAt();

    publishDocumentEdit({ surfaceId: "surf-1" });

    expect(unseenFor("conv-1")).toEqual(["surf-1"]);
  });

  test("records nothing when that document is the one on screen", () => {
    openInViewer("surf-1");
    renderSyncAt();

    publishDocumentEdit({ surfaceId: "surf-1" });

    expect(unseenFor("conv-1")).toEqual([]);
  });

  test("records an unseen change when a different document is on screen", () => {
    openInViewer("surf-1");
    renderSyncAt();

    publishDocumentEdit({ surfaceId: "surf-2" });

    expect(unseenFor("conv-1")).toEqual(["surf-2"]);
  });

  test("records against the conversation the edit came from", () => {
    renderSyncAt();

    publishDocumentEdit({ conversationId: "conv-2", surfaceId: "surf-1" });

    expect(unseenFor("conv-1")).toEqual([]);
    expect(unseenFor("conv-2")).toEqual(["surf-1"]);
  });

  test("applies the streamed content to the open document", () => {
    openInViewer("surf-1");
    renderSyncAt();

    publishDocumentEdit({ surfaceId: "surf-1", markdown: "# Rewritten" });

    expect(useViewerStore.getState().openedDocumentState).toMatchObject({
      surfaceId: "surf-1",
      content: "# Rewritten",
    });
  });

  test("records an unseen change when the drawer is open but the route is not chat", () => {
    openInViewer("surf-1");
    renderSyncAt(routes.library.root);

    publishDocumentEdit({ surfaceId: "surf-1" });

    expect(unseenFor("conv-1")).toEqual(["surf-1"]);
  });

  test("records an unseen change on the standalone document route", () => {
    openInViewer("surf-1");
    renderSyncAt(routes.document("surf-1"));

    publishDocumentEdit({ surfaceId: "surf-1" });

    expect(unseenFor("conv-1")).toEqual(["surf-1"]);
  });

  test("clears the record when the user returns to chat with the document open", () => {
    openInViewer("surf-1");
    renderSyncAt(routes.library.root);

    publishDocumentEdit({ surfaceId: "surf-1" });
    expect(unseenFor("conv-1")).toEqual(["surf-1"]);

    navigateTo(routes.conversation("conv-1"));

    expect(unseenFor("conv-1")).toEqual([]);
  });

  test("returning to chat clears a record made from another conversation", () => {
    openInViewer("surf-1");
    renderSyncAt(routes.library.root);

    publishDocumentEdit({ conversationId: "conv-2", surfaceId: "surf-1" });
    expect(unseenFor("conv-2")).toEqual(["surf-1"]);

    navigateTo(routes.conversation("conv-1"));

    expect(unseenFor("conv-2")).toEqual([]);
  });

  test("returning to chat leaves a document other than the open one unseen", () => {
    openInViewer("surf-1");
    renderSyncAt(routes.library.root);

    publishDocumentEdit({ surfaceId: "surf-2" });
    navigateTo(routes.conversation("conv-1"));

    expect(unseenFor("conv-1")).toEqual(["surf-2"]);
  });

  test("returning to chat with no document open clears nothing", () => {
    renderSyncAt(routes.library.root);

    publishDocumentEdit({ surfaceId: "surf-1" });
    navigateTo(routes.conversation("conv-1"));

    expect(unseenFor("conv-1")).toEqual(["surf-1"]);
  });

  test("still applies the streamed content off the chat route", () => {
    openInViewer("surf-1");
    renderSyncAt(routes.settings.general);

    publishDocumentEdit({ surfaceId: "surf-1", markdown: "# Rewritten" });

    expect(useViewerStore.getState().openedDocumentState).toMatchObject({
      surfaceId: "surf-1",
      content: "# Rewritten",
    });
  });
});
