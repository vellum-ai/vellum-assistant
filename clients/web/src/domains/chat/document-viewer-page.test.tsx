/**
 * The standalone `/assistant/documents/:surfaceId` route is a second way into
 * a document, so opening one there clears its unseen-change record just as the
 * in-chat viewer does.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useImperativeHandle, type Ref } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import type { DocumentsByIdGetResponse } from "@/generated/daemon/types.gen";
import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useViewerStore } from "@/stores/viewer-store";

const daemonSdk = await import("@/generated/daemon/sdk.gen");

type DocumentResult = { data: DocumentsByIdGetResponse | null };

let documentResult: () => Promise<DocumentResult> = () =>
  Promise.reject(new Error("not stubbed"));
let mobile = false;
let conversationExists = true;
const createConversation = mock(async () => ({ data: { id: "conv-created" } }));
const linkConversation = mock(async () => ({}));
const savedDocument = { title: "Saved title", content: "Saved body" };
const release = mock(() => {});

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  documentsByIdGet: () => documentResult(),
  conversationsByIdGet: ({ path }: { path: { id: string } }) =>
    Promise.resolve({
      data: { conversation: { id: path.id } },
      response: new Response(null, { status: conversationExists ? 200 : 404 }),
    }),
  conversationsPost: createConversation,
  documentsByIdConversationsPost: linkConversation,
}));

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mobile,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));
mock.module("@/hooks/use-is-org-ready", () => ({
  useOrgHeaderReadiness: () => "ready",
}));
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: mock(() => {}),
}));

// The editor is a heavy Tiptap tree with nothing to say about the record.
mock.module("./components/document-viewer-container", () => ({
  DocumentViewerContainer: ({
    handleRef,
    onSubmitFeedback,
    onClose,
  }: {
    handleRef: Ref<unknown>;
    onSubmitFeedback: () => void;
    onClose: () => void;
  }) => {
    useImperativeHandle(handleRef, () => ({
      beginSendPreparation: () => ({
        flush: async () => savedDocument,
        release,
        isCurrent: () => true,
      }),
      refreshComments: async () => {},
    }));
    return (
      <div data-testid="viewer">
        <button onClick={onSubmitFeedback}>Feedback</button>
        <button onClick={onClose}>Close</button>
      </div>
    );
  },
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
    ...overrides,
  };
}

function renderPage(surfaceId: string) {
  return render(
    <MemoryRouter initialEntries={[`/assistant/documents/${surfaceId}`]}>
      <Routes>
        <Route
          path="/assistant/conversations/:conversationId"
          element={<Destination />}
        />
        <Route
          path="/assistant/library"
          element={<div data-testid="library" />}
        />
        <Route
          path="/assistant/documents/:surfaceId"
          element={<DocumentViewerPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function Destination() {
  const location = useLocation();
  return (
    <div data-testid="chat-route">
      {location.pathname}
      {location.search}
    </div>
  );
}

function unseenFor(conversationId: string): string[] {
  const changed =
    useUnseenDocumentChangesStore.getState().changedDocuments[conversationId];
  return [...(changed ?? [])];
}

beforeEach(() => {
  mobile = false;
  conversationExists = true;
  createConversation.mockClear();
  linkConversation.mockClear();
  release.mockClear();
  window.sessionStorage.clear();
  useResolvedAssistantsStore.setState({
    activeAssistantId: "asst-1",
    assistantsHydrated: true,
  });
  useAssistantIdentityStore.setState({
    assistantId: "asst-1",
    version: "0.11.12",
  });
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
});

afterEach(() => {
  cleanup();
});

describe("DocumentViewerPage", () => {
  test("mobile enters the linked conversation with refreshable document intent", async () => {
    mobile = true;
    useUnseenDocumentChangesStore
      .getState()
      .markDocumentChanged("conv-1", "surf-1");
    documentResult = () => Promise.resolve({ data: documentSurface() });
    const page = renderPage("surf-1");
    const target = await page.findByTestId("chat-route");
    expect(target.textContent).toContain(
      "/assistant/conversations/conv-1?document=surf-1",
    );
    expect(target.textContent).toContain(
      "documentReturn=%2Fassistant%2Flibrary",
    );
    expect(createConversation).not.toHaveBeenCalled();
    expect(unseenFor("conv-1")).toEqual([]);
  });

  test("a missing conversation leaves the document editable until explicit recovery", async () => {
    mobile = true;
    conversationExists = false;
    documentResult = () => Promise.resolve({ data: documentSurface() });
    const page = renderPage("surf-1");
    await page.findByTestId("viewer");
    expect(createConversation).not.toHaveBeenCalled();
    fireEvent.click(page.getByText("Start a linked conversation"));
    const target = await page.findByTestId("chat-route");
    expect(target.textContent).toContain(
      "/assistant/conversations/conv-created?document=surf-1",
    );
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(linkConversation).toHaveBeenCalledTimes(1);
    expect(useViewerStore.getState().openedDocumentState).toMatchObject({
      documentName: "Saved title",
      content: "Saved body",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("feedback flushes latest title and body before entering the normal send route", async () => {
    documentResult = () => Promise.resolve({ data: documentSurface() });
    const page = renderPage("surf-1");
    await page.findByTestId("viewer");
    fireEvent.click(page.getByText("Feedback"));
    const target = await page.findByTestId("chat-route");
    expect(decodeURIComponent(target.textContent ?? "")).toContain(
      'Please review and address my comments on "Saved title".',
    );
    expect(useViewerStore.getState().openedDocumentState).toMatchObject({
      documentName: "Saved title",
      content: "Saved body",
    });
    expect(createConversation).not.toHaveBeenCalled();
  });

  test("a settled missing assistant shows a fallback instead of a permanent spinner", async () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    const page = renderPage("surf-1");
    await page.findByText("Document not found.");
    fireEvent.click(page.getByText("Go back"));
    await page.findByTestId("library");
  });
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
