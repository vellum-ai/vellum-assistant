/**
 * Tests for the end-of-turn link back to a document the assistant changed.
 *
 * Covers the two things the link owes its caller: it names the document from
 * the documents query, rendering only once a resolved list carries the
 * document, and it is present exactly when its own document is not the one
 * open in the viewer.
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
const OTHER_CONVERSATION_ID = "conv-2";
const SURFACE_ID = "surf-notes";

const onOpenDocument = mock((_surfaceId: string) => {});

type SeededDocument = {
  surfaceId: string;
  title: string;
  conversationId?: string;
};

function seededPayload(documents: SeededDocument[]) {
  return {
    documents: documents.map((doc) => ({
      surfaceId: doc.surfaceId,
      conversationId: doc.conversationId ?? CONVERSATION_ID,
      title: doc.title,
      wordCount: 0,
      createdAt: 0,
      updatedAt: 0,
    })),
  };
}

/** A client that never refetches, so a seeded entry needs no network. */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function renderWithClient(
  queryClient: QueryClient,
  conversationId: string | null,
): void {
  const ui: ReactNode = (
    <DocumentReopenLink
      surfaceId={SURFACE_ID}
      assistantId={ASSISTANT_ID}
      conversationId={conversationId}
      onOpenDocument={onOpenDocument}
    />
  );
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

/**
 * Render the link with the conversation-scoped documents query answered, and
 * the assistant-wide fallback answered too when `assistantWide` is given.
 */
function renderLink(
  documents: SeededDocument[],
  assistantWide?: SeededDocument[],
): void {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(
    documentsGetQueryKey({
      path: { assistant_id: ASSISTANT_ID },
      query: { conversationId: CONVERSATION_ID },
    }),
    seededPayload(documents),
  );
  if (assistantWide) {
    queryClient.setQueryData(
      documentsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
      seededPayload(assistantWide),
    );
  }
  renderWithClient(queryClient, CONVERSATION_ID);
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

const realFetch = globalThis.fetch;

beforeEach(() => {
  onOpenDocument.mockClear();
  useViewerStore.setState({ mainView: "chat", openedDocumentState: null });
  // An unseeded query leaves the link in its loading state for the whole test
  // instead of reaching the network.
  globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), {
    preconnect: () => {},
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

describe("DocumentReopenLink", () => {
  test("names the document from the documents query", () => {
    renderLink([{ surfaceId: SURFACE_ID, title: "Quarterly notes" }]);

    expect(screen.getByText("Quarterly notes")).toBeTruthy();
    expect(screen.getByTestId("document-reopen-link")).toBeTruthy();
  });

  test("renders nothing until the documents query resolves", () => {
    renderWithClient(makeQueryClient(), CONVERSATION_ID);

    expect(screen.queryByTestId("document-reopen-link")).toBeNull();
    expect(screen.queryByText("Untitled document")).toBeNull();
  });

  test("names a document edited from another conversation", () => {
    // The assistant can edit any document it reaches, and the edit does not
    // link that document to the conversation it was made from, so this
    // conversation's list misses it while the assistant-wide list carries it.
    renderLink(
      [{ surfaceId: "surf-other", title: "Some other doc" }],
      [
        {
          surfaceId: SURFACE_ID,
          title: "Quarterly notes",
          conversationId: OTHER_CONVERSATION_ID,
        },
      ],
    );

    expect(screen.getByText("Quarterly notes")).toBeTruthy();
    expect(screen.getByTestId("document-reopen-link")).toBeTruthy();
  });

  test("renders nothing for a document neither resolved list carries", () => {
    renderLink(
      [{ surfaceId: "surf-other", title: "Some other doc" }],
      [{ surfaceId: "surf-other", title: "Some other doc" }],
    );

    expect(screen.queryByTestId("document-reopen-link")).toBeNull();
  });

  test("renders nothing while the assistant-wide fallback is unresolved", () => {
    renderLink([{ surfaceId: "surf-other", title: "Some other doc" }]);

    expect(screen.queryByTestId("document-reopen-link")).toBeNull();
  });

  test("falls back to a neutral label for a document with an empty title", () => {
    renderLink([{ surfaceId: SURFACE_ID, title: "  " }]);

    expect(screen.getByText("Untitled document")).toBeTruthy();
    expect(screen.getByTestId("document-reopen-link")).toBeTruthy();
  });

  test("reads the assistant-wide list when there is no conversation", () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      documentsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
      seededPayload([{ surfaceId: SURFACE_ID, title: "Quarterly notes" }]),
    );
    renderWithClient(queryClient, null);

    expect(screen.getByText("Quarterly notes")).toBeTruthy();
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
