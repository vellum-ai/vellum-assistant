/**
 * Tests for the document viewer's autosave: where a pending edit goes when the
 * container is taken down, and what it refreshes once it lands.
 *
 * The editor and the comment panel are stubbed. What this covers is the
 * container's own job (debounce, flush, cache invalidation), not Tiptap's.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type { ReactNode } from "react";

const saveDocumentContent = mock(
  async (_target: unknown, _markdown: string) => ({ success: true }) as unknown,
);
const documentSave = await import("@/domains/chat/api/document-save");
mock.module("@/domains/chat/api/document-save", () => ({
  ...documentSave,
  saveDocumentContent,
}));

const documentComments = await import("@/domains/chat/api/document-comments");
mock.module("@/domains/chat/api/document-comments", () => ({
  ...documentComments,
  fetchComments: mock(async () => []),
  createComment: mock(async () => ({})),
}));

mock.module("./document-comment-panel", () => ({
  DocumentCommentPanel: () => <div data-testid="comment-panel" />,
}));

// The editor is a lazy chunk. The stub gives the test a way to emit the update
// the real editor emits on a keystroke.
mock.module("./tiptap-document-editor", () => ({
  TiptapDocumentEditor: ({
    onContentChange,
  }: {
    onContentChange: (markdown: string) => void;
  }) => (
    <button type="button" onClick={() => onContentChange("edited body")}>
      type
    </button>
  ),
}));

const { DocumentViewerContainer } = await import(
  "@/domains/chat/components/document-viewer-container"
);

interface RenderResult {
  unmount: () => void;
  invalidatedKeys: QueryKey[];
}

function renderViewer(
  props: { workspacePath?: string | null } = {},
): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidatedKeys: QueryKey[] = [];
  const realInvalidate = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters?: { queryKey?: QueryKey }) => {
    if (filters?.queryKey) {
      invalidatedKeys.push(filters.queryKey);
    }
    return realInvalidate(filters);
  }) as typeof queryClient.invalidateQueries;

  const { unmount } = render(
    <DocumentViewerContainer
      source="document"
      assistantId="asst-1"
      documentName="notes.md"
      content="# Notes"
      onClose={() => {}}
      surfaceId="surf-1"
      conversationId="conv-1"
      workspacePath={props.workspacePath ?? null}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
  return { unmount, invalidatedKeys };
}

/** Emit one editor update and wait for the editor stub to have mounted. */
async function typeIntoEditor(): Promise<void> {
  const editor = await waitFor(() =>
    screen.getByRole("button", { name: "type" }),
  );
  fireEvent.click(editor);
}

afterEach(() => {
  cleanup();
  saveDocumentContent.mockClear();
});

describe("DocumentViewerContainer autosave", () => {
  test("an edit still pending when the container goes away is flushed", async () => {
    const { unmount } = renderViewer();
    await typeIntoEditor();

    // Well inside the debounce window: the timer has not fired.
    expect(saveDocumentContent).not.toHaveBeenCalled();

    unmount();

    expect(saveDocumentContent).toHaveBeenCalledTimes(1);
    expect(saveDocumentContent.mock.calls[0]![0]).toEqual({
      source: "document",
      assistantId: "asst-1",
      surfaceId: "surf-1",
      conversationId: "conv-1",
      title: "notes.md",
    });
    expect(saveDocumentContent.mock.calls[0]![1]).toBe("edited body");
  });

  test("the flushed save is not written a second time by the dead timer", async () => {
    const { unmount } = renderViewer();
    await typeIntoEditor();
    unmount();

    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(saveDocumentContent).toHaveBeenCalledTimes(1);
  });

  test("nothing is written when no edit is pending", () => {
    const { unmount } = renderViewer();
    unmount();

    expect(saveDocumentContent).not.toHaveBeenCalled();
  });

  test("a file-backed save refreshes every query holding the file's bytes", async () => {
    const { unmount, invalidatedKeys } = renderViewer({
      workspacePath: "drafts/notes.md",
    });
    await typeIntoEditor();
    unmount();

    await waitFor(() => expect(invalidatedKeys.length).toBe(3));
    expect(invalidatedKeys).toEqual([
      ["assistantsWorkspaceFileRetrieve"],
      ["local-file-blob", "asst-1", "drafts/notes.md"],
      ["local-file-info", "asst-1", "drafts/notes.md"],
    ]);
  });

  test("a document with no file behind it refreshes nothing", async () => {
    const { unmount, invalidatedKeys } = renderViewer();
    await typeIntoEditor();
    unmount();

    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    expect(invalidatedKeys).toEqual([]);
  });
});
