/**
 * The standalone `/assistant/documents/:surfaceId` route is a second way into
 * a document, so opening one there clears its unseen-change record just as the
 * in-chat viewer does. It also hosts the mobile document composer inside
 * `RootLayout`'s app shell, which already pads the bottom safe area, so the
 * composer is handed no inset of its own.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";

import type { DocumentsByIdGetResponse } from "@/generated/daemon/types.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";

const daemonSdk = await import("@/generated/daemon/sdk.gen");

type DocumentResult = { data: DocumentsByIdGetResponse | null };

let documentResult: () => Promise<DocumentResult> = () =>
  Promise.reject(new Error("not stubbed"));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  documentsByIdGet: () => documentResult(),
}));

// The editor is a heavy Tiptap tree with nothing to say about the record.
mock.module("./components/document-viewer-container", () => ({
  DocumentViewerContainer: () => <div data-testid="viewer" />,
}));

let mockIsMobile = false;
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mockIsMobile,
}));

let composerPanelProps: Record<string, unknown> | null = null;
mock.module("@/domains/chat/components/document-composer-panel", () => ({
  DocumentComposerPanel: (props: Record<string, unknown>) => {
    composerPanelProps = props;
    return <div data-testid="doc-composer-panel" />;
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

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="go" onClick={() => navigate(to)}>
      go
    </button>
  );
}

function renderPage(surfaceId: string, navigateTo?: string) {
  return render(
    <MemoryRouter initialEntries={[`/assistant/documents/${surfaceId}`]}>
      <Routes>
        <Route
          path="/assistant/documents/:surfaceId"
          element={<DocumentViewerPage />}
        />
      </Routes>
      {navigateTo ? <GoTo to={navigateTo} /> : null}
    </MemoryRouter>,
  );
}

function unseenFor(conversationId: string): string[] {
  const changed =
    useUnseenDocumentChangesStore.getState().changedDocuments[conversationId];
  return [...(changed ?? [])];
}

beforeEach(() => {
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
  mockIsMobile = false;
  composerPanelProps = null;
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

describe("DocumentViewerPage: mobile composer", () => {
  test("renders no document composer on desktop", async () => {
    mockIsMobile = false;
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId, queryByTestId } = renderPage("surf-1");
    await findByTestId("viewer");

    expect(queryByTestId("doc-composer-panel")).toBeNull();
  });

  test("pins a document composer below the viewer on mobile", async () => {
    mockIsMobile = true;
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("viewer");
    await findByTestId("doc-composer-panel");

    expect(composerPanelProps?.assistantId).toBe("asst-1");
    expect(composerPanelProps?.doc).toEqual({
      surfaceId: "surf-1",
      conversationId: "conv-1",
    });
  });

  test("hands the composer no document while the loaded one is not the route's", async () => {
    mockIsMobile = true;
    documentResult = () =>
      Promise.resolve({ data: documentSurface({ surfaceId: "surf-2" }) });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("doc-composer-panel");

    expect(composerPanelProps?.doc).toBeNull();
  });

  test("drops the composer's document while the route moves ahead of the load", async () => {
    // One page instance spans both URLs, and the loaded document trails the
    // param until the next fetch resolves, so the composer must not stay
    // pointed at the document the URL has already left.
    mockIsMobile = true;
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId, getByTestId } = renderPage(
      "surf-1",
      "/assistant/documents/surf-2",
    );
    await findByTestId("doc-composer-panel");
    expect(composerPanelProps?.doc).toEqual({
      surfaceId: "surf-1",
      conversationId: "conv-1",
    });

    documentResult = () => new Promise<DocumentResult>(() => {});
    fireEvent.click(getByTestId("go"));

    await waitFor(() => {
      expect(composerPanelProps?.doc).toBeNull();
    });
  });

  test("drops the composer's document while the assistant moves ahead of the load", async () => {
    // The route param holds still when the active assistant changes, so the
    // surface half of the gate keeps passing while the document fetched for
    // the outgoing assistant is still the one on screen.
    mockIsMobile = true;
    documentResult = () => Promise.resolve({ data: documentSurface() });

    const { findByTestId } = renderPage("surf-1");
    await findByTestId("doc-composer-panel");
    expect(composerPanelProps?.doc).toEqual({
      surfaceId: "surf-1",
      conversationId: "conv-1",
    });

    let resolveReload: (result: DocumentResult) => void = () => {};
    documentResult = () =>
      new Promise<DocumentResult>((resolve) => {
        resolveReload = resolve;
      });
    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "asst-2" });
    });

    await waitFor(() => {
      expect(composerPanelProps?.assistantId).toBe("asst-2");
      expect(composerPanelProps?.doc).toBeNull();
    });

    resolveReload({ data: documentSurface({ conversationId: "conv-2" }) });

    await waitFor(() => {
      expect(composerPanelProps?.doc).toEqual({
        surfaceId: "surf-1",
        conversationId: "conv-2",
      });
    });
  });
});
