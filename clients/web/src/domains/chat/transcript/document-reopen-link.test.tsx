/**
 * Tests for the end-of-turn link back to a document the assistant changed.
 *
 * Covers the two things the link owes its caller: it names the document from
 * the documents query (with a neutral label when the query has no title for
 * it), and it is present exactly when its own document is not the one open in
 * the viewer.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { DocumentReopenLink } from "@/domains/chat/transcript/document-reopen-link";
import { documentsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useViewerStore } from "@/stores/viewer-store";

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";
const SURFACE_ID = "surf-notes";

const onOpenDocument = mock((_surfaceId: string) => {});

type SeededDocument = { surfaceId: string; title: string };

/**
 * Render the link with the documents query already answered. `staleTime` is
 * infinite so the seeded entry is never refetched and the test needs no network.
 */
function renderLink(documents: SeededDocument[]): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(
    documentsGetQueryKey({
      path: { assistant_id: ASSISTANT_ID },
      query: { conversationId: CONVERSATION_ID },
    }),
    {
      documents: documents.map((doc) => ({
        surfaceId: doc.surfaceId,
        conversationId: CONVERSATION_ID,
        title: doc.title,
        wordCount: 0,
        createdAt: 0,
        updatedAt: 0,
      })),
    },
  );
  const ui: ReactNode = (
    <DocumentReopenLink
      surfaceId={SURFACE_ID}
      assistantId={ASSISTANT_ID}
      conversationId={CONVERSATION_ID}
      onOpenDocument={onOpenDocument}
    />
  );
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

/** Put the viewer store where it would be with `surfaceId` open in the drawer. */
function openDocument(surfaceId: string): void {
  useViewerStore.setState({
    mainView: "document",
    openedDocumentState: {
      source: "document",
      surfaceId,
      conversationId: CONVERSATION_ID,
      documentName: "Quarterly notes",
      content: "# notes",
    },
  });
}

beforeEach(() => {
  onOpenDocument.mockClear();
  useViewerStore.setState({ mainView: "chat", openedDocumentState: null });
});

afterEach(() => {
  cleanup();
});

describe("DocumentReopenLink", () => {
  test("names the document from the documents query", () => {
    renderLink([{ surfaceId: SURFACE_ID, title: "Quarterly notes" }]);

    expect(screen.getByText("Quarterly notes")).toBeTruthy();
    expect(screen.getByTestId("document-reopen-link")).toBeTruthy();
  });

  test("falls back to a neutral label when the query has no title", () => {
    renderLink([{ surfaceId: "surf-other", title: "Some other doc" }]);

    expect(screen.getByText("Untitled document")).toBeTruthy();
    expect(screen.getByTestId("document-reopen-link")).toBeTruthy();
  });

  test("hides itself while its own document is open", () => {
    openDocument(SURFACE_ID);
    renderLink([{ surfaceId: SURFACE_ID, title: "Quarterly notes" }]);

    expect(screen.queryByTestId("document-reopen-link")).toBeNull();
  });

  test("stays visible while a different document is open", () => {
    openDocument("surf-other");
    renderLink([{ surfaceId: SURFACE_ID, title: "Quarterly notes" }]);

    expect(screen.getByTestId("document-reopen-link")).toBeTruthy();
    expect(screen.getByText("Quarterly notes")).toBeTruthy();
  });

  test("clicking opens the document it names", () => {
    renderLink([
      { surfaceId: "surf-other", title: "Some other doc" },
      { surfaceId: SURFACE_ID, title: "Quarterly notes" },
    ]);

    fireEvent.click(screen.getByTestId("document-reopen-link"));

    expect(onOpenDocument).toHaveBeenCalledTimes(1);
    expect(onOpenDocument.mock.calls[0]).toEqual([SURFACE_ID]);
  });
});
