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
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, type ReactNode } from "react";
import type {
  DocumentViewerContainerHandle,
  DocumentViewerContainerProps,
} from "./document-viewer-container";

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
    editable,
  }: {
    onContentChange: (markdown: string) => void;
    editable: boolean;
  }) => (
    <button type="button" disabled={!editable} onClick={() => onContentChange("edited body")}>
      type
    </button>
  ),
}));

const { DocumentViewerContainer } = await import(
  "@/domains/chat/components/document-viewer-container"
);

interface RenderResult {
  unmount: () => void;
  rerender: (props: Partial<DocumentViewerContainerProps>) => void;
}

function renderViewer(
  props: Partial<DocumentViewerContainerProps> = {},
): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const viewer = (overrides: Partial<DocumentViewerContainerProps>) => (
    <DocumentViewerContainer
      source="document"
      assistantId="asst-1"
      documentName="notes.md"
      content="# Notes"
      onClose={() => {}}
      surfaceId="surf-1"
      conversationId="conv-1"
      {...props}
      {...overrides}
    />
  );
  const { unmount, rerender } = render(
    viewer({}),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
  return { unmount, rerender: (overrides) => rerender(viewer(overrides)) };
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

    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
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

describe("DocumentViewerContainer preparation", () => {
  test("the preparation handle disables editing and rename affordances", async () => {
    const handleRef = createRef<DocumentViewerContainerHandle>();
    renderViewer({ handleRef });
    await typeIntoEditor();
    let lease!: ReturnType<DocumentViewerContainerHandle["beginSendPreparation"]>;
    act(() => {
      lease = handleRef.current!.beginSendPreparation();
    });
    expect((screen.getByRole("button", { name: "type" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Document options" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      expect(await lease.flush()).toEqual({ title: "notes.md", content: "edited body" });
      lease.release();
    });
    expect((screen.getByRole("button", { name: "type" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("the same surface under another assistant invalidates the old preparation", async () => {
    const handleRef = createRef<DocumentViewerContainerHandle>();
    const { rerender } = renderViewer({ handleRef });
    await typeIntoEditor();
    const oldHandle = handleRef.current!;
    let lease!: ReturnType<DocumentViewerContainerHandle["beginSendPreparation"]>;
    act(() => {
      lease = oldHandle.beginSendPreparation();
    });
    rerender({ assistantId: "asst-2", content: "Another assistant's notes" });
    expect(lease.isCurrent()).toBe(false);
    await expect(lease.flush()).rejects.toThrow("no longer active");
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    expect(saveDocumentContent.mock.calls[0]![0]).toMatchObject({ assistantId: "asst-1" });
    await act(async () => {
      expect(await handleRef.current!.flushPendingSave()).toEqual({ title: "notes.md", content: "Another assistant's notes" });
    });
    expect(handleRef.current).not.toBe(oldHandle);
  });
});
