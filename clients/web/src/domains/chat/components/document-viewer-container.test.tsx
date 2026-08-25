/**
 * Tests for the document viewer's writes: where a pending edit goes when the
 * container is taken down, and what a rename sends along with the new title.
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
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
}

function renderViewer(
  props: { onRenamed?: (documentName: string) => void } = {},
): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const { unmount } = render(
    <DocumentViewerContainer
      source="document"
      assistantId="asst-1"
      documentName="notes.md"
      content="# Notes"
      onClose={() => {}}
      surfaceId="surf-1"
      conversationId="conv-1"
      onRenamed={props.onRenamed}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
  return { unmount };
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
  // Radix locks body pointer events while a menu is open; a test that leaves
  // one open must not disable pointers for the next one.
  document.body.style.pointerEvents = "";
});

/** Walk the overflow menu into the rename dialog and submit `name`. */
async function renameTo(name: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Document options" }));
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));

  const input = await screen.findByLabelText("Name");
  await user.clear(input);
  await user.type(input, name);
  await user.click(screen.getByRole("button", { name: "Save" }));
}

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
});

describe("DocumentViewerContainer rename", () => {
  test("the rename writes the new title with the body the editor holds", async () => {
    const onRenamed = mock((_documentName: string) => {});
    renderViewer({ onRenamed });
    await typeIntoEditor();

    await renameTo("meeting notes");

    // The caller takes the name straight away, the way a conversation rename
    // does, rather than after the round trip.
    expect(onRenamed).toHaveBeenCalledTimes(1);
    expect(onRenamed.mock.calls[0]![0]).toBe("meeting notes");

    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    expect(saveDocumentContent.mock.calls[0]![0]).toEqual({
      source: "document",
      assistantId: "asst-1",
      surfaceId: "surf-1",
      conversationId: "conv-1",
      title: "meeting notes",
    });
    // The edit was still inside the debounce window: the rename carries it
    // instead of leaving it to a save that would restore the old title.
    expect(saveDocumentContent.mock.calls[0]![1]).toBe("edited body");
  });

  test("the folded-in edit is not written a second time by the dead timer", async () => {
    renderViewer();
    await typeIntoEditor();
    await renameTo("meeting notes");

    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(saveDocumentContent).toHaveBeenCalledTimes(1);
  });

  test("the name it already has is not a rename, and writes nothing", async () => {
    const onRenamed = mock((_documentName: string) => {});
    renderViewer({ onRenamed });

    await renameTo("notes.md");

    expect(onRenamed).not.toHaveBeenCalled();
    expect(saveDocumentContent).not.toHaveBeenCalled();
  });
});
