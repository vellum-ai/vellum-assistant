/**
 * The standalone `/assistant/documents/:surfaceId` route is a second way into
 * a document, so opening one there clears its unseen-change record just as the
 * in-chat viewer does.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import type { DocumentsByIdGetResponse } from "@/generated/daemon/types.gen";
import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";

const daemonSdk = await import("@/generated/daemon/sdk.gen");

type DocumentResult = { data: DocumentsByIdGetResponse | null };

let documentResult: () => Promise<DocumentResult> = () =>
  Promise.reject(new Error("not stubbed"));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  documentsByIdGet: () => documentResult(),
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: { use: { activeAssistantId: () => "asst-1" } },
}));

// The editor is a heavy Tiptap tree with nothing to say about the record.
mock.module("./components/document-viewer-container", () => ({
  DocumentViewerContainer: () => <div data-testid="viewer" />,
}));

const { DocumentViewerPage } = await import(
  "@/domains/chat/document-viewer-page"
);

function documentSurface(
  overrides: Partial<DocumentsByIdGetResponse> = {},
): DocumentsByIdGetResponse {
  return {
    success: true,
    surfaceId: "surf-1",
    conversationId: "conv-1",
    title: "Notes",
    content: "# Notes",
    wordCount: 2,
    createdAt: 1,
    updatedAt: 2,
    workspacePath: null,
    ...overrides,
  };
}

function renderPage(surfaceId: string) {
  return render(
    <MemoryRouter initialEntries={[`/assistant/documents/${surfaceId}`]}>
      <Routes>
        <Route
          path="/assistant/documents/:surfaceId"
          element={<DocumentViewerPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function unseenFor(conversationId: string): string[] {
  const changed =
    useUnseenDocumentChangesStore.getState().changedDocuments[conversationId];
  return [...(changed ?? [])];
}

beforeEach(() => {
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
});

afterEach(() => {
  cleanup();
});

describe("DocumentViewerPage", () => {
  test("clears the unseen change for the document it loaded", async () => {
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-1", "surf-1");
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("viewer");

    expect(unseenFor("conv-1")).toEqual([]);
  });

  test("leaves the conversation's other unseen documents alone", async () => {
    const unseen = useUnseenDocumentChangesStore.getState();
    unseen.markDocumentChanged("conv-1", "surf-1");
    unseen.markDocumentChanged("conv-1", "surf-2");
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("viewer");

    expect(unseenFor("conv-1")).toEqual(["surf-2"]);
  });

  test("clears a change recorded against a conversation other than the document's", async () => {
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-2", "surf-1");
    documentResult = () =>
      Promise.resolve({ data: documentSurface({ conversationId: "conv-1" }) });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("viewer");

    expect(unseenFor("conv-2")).toEqual([]);
  });

  test("keeps the unseen change when the load fails", async () => {
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-1", "surf-1");
    documentResult = () => Promise.reject(new Error("boom"));

    renderPage("surf-1");
    await waitFor(() => {
      expect(unseenFor("conv-1")).toEqual(["surf-1"]);
    });
  });
});
