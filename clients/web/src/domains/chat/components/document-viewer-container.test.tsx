/**
 * Tests for the document viewer's writes: where a pending edit goes when the
 * container is taken down, and what a rename sends along with the new title.
 *
 * The editor and the comment panel are stubbed. What this covers is the
 * container's own job (debounce, flush, cache invalidation), not Tiptap's.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, type ReactNode, type Ref, useState } from "react";

import type { DocumentViewerContainerHandle } from "@/domains/chat/components/document-viewer-container";

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

let commentPanelProps: Record<string, unknown> = {};
mock.module("./document-comment-panel", () => ({
  DocumentCommentPanel: (props: Record<string, unknown>) => {
    commentPanelProps = props;
    return <div data-testid="comment-panel" />;
  },
}));

// The editor is a lazy chunk. The stub gives the test a way to emit the update
// the real editor emits on a keystroke.
let editorMarkdown = "edited body";
mock.module("./tiptap-document-editor", () => ({
  TiptapDocumentEditor: ({
    onContentChange,
  }: {
    onContentChange: (markdown: string) => void;
  }) => (
    <button type="button" onClick={() => onContentChange(editorMarkdown)}>
      type
    </button>
  ),
}));

const { DocumentViewerContainer } =
  await import("@/domains/chat/components/document-viewer-container");

interface RenderResult {
  unmount: () => void;
}

function renderViewer(
  props: {
    onRenamed?: (documentName: string) => void;
    onSubmitFeedback?: () => void;
    handleRef?: Ref<DocumentViewerContainerHandle>;
  } = {},
): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function ViewerHarness() {
    const [documentName, setDocumentName] = useState("notes.md");
    return (
      <DocumentViewerContainer
        source="document"
        assistantId="asst-1"
        documentName={documentName}
        content="# Notes"
        onClose={() => {}}
        surfaceId="surf-1"
        conversationId="conv-1"
        onRenamed={(nextName) => {
          setDocumentName(nextName);
          props.onRenamed?.(nextName);
        }}
        onSubmitFeedback={props.onSubmitFeedback}
        handleRef={props.handleRef}
      />
    );
  }

  const { unmount } = render(
    <ViewerHarness />,
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
async function typeIntoEditor(markdown = "edited body"): Promise<void> {
  editorMarkdown = markdown;
  const editor = await waitFor(() =>
    screen.getByRole("button", { name: "type" }),
  );
  fireEvent.click(editor);
}

afterEach(() => {
  cleanup();
  saveDocumentContent.mockClear();
  editorMarkdown = "edited body";
  commentPanelProps = {};
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

async function openComments(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Document options" }));
  await user.click(await screen.findByRole("menuitem", { name: "Comments" }));
  await screen.findByTestId("comment-panel");
}

describe("DocumentViewerContainer autosave", () => {
  test("flushes document edits before launching feedback", async () => {
    let finishSave: () => void = () => {};
    saveDocumentContent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ success: true } as unknown);
        }),
    );
    const onSubmitFeedback = mock(() => {});
    renderViewer({ onSubmitFeedback });
    await typeIntoEditor("latest body");
    await openComments();

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = (
        commentPanelProps.onSubmitFeedback as () => Promise<void>
      )();
    });
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    expect(onSubmitFeedback).not.toHaveBeenCalled();

    await act(async () => {
      finishSave();
      await submitted;
    });

    expect(onSubmitFeedback).toHaveBeenCalledTimes(1);
  });

  test("flushes and awaits the latest edit before a sibling action continues", async () => {
    let finishSave: () => void = () => {};
    saveDocumentContent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ success: true } as unknown);
        }),
    );
    const handleRef = createRef<DocumentViewerContainerHandle>();
    renderViewer({ handleRef });
    await typeIntoEditor("latest body");

    let flushed = false;
    const flush = handleRef.current!.flushPendingSave().then(() => {
      flushed = true;
    });
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    expect(flushed).toBe(false);
    expect(saveDocumentContent.mock.calls[0]![1]).toBe("latest body");

    await act(async () => {
      finishSave();
      await flush;
    });
    expect(flushed).toBe(true);
  });

  test("serializes a newer flush behind an autosave already in flight", async () => {
    let finishFirst: () => void = () => {};
    let finishSecond: () => void = () => {};
    saveDocumentContent
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = () => resolve({ success: true } as unknown);
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = () => resolve({ success: true } as unknown);
          }),
      );
    const handleRef = createRef<DocumentViewerContainerHandle>();
    renderViewer({ handleRef });

    await typeIntoEditor("older body");
    const firstFlush = handleRef.current!.flushPendingSave();
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));

    await typeIntoEditor("latest body");
    const latestFlush = handleRef.current!.flushPendingSave();
    await act(async () => {});
    expect(saveDocumentContent).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirst();
      await firstFlush;
    });
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(2));
    expect(saveDocumentContent.mock.calls.map((call) => call[1])).toEqual([
      "older body",
      "latest body",
    ]);

    await act(async () => {
      finishSecond();
      await latestFlush;
    });
  });

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
  test("a sibling flush waits for the rename write containing the latest body", async () => {
    let finishRename: () => void = () => {};
    saveDocumentContent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRename = () => resolve({ success: true } as unknown);
        }),
    );
    const handleRef = createRef<DocumentViewerContainerHandle>();
    renderViewer({ handleRef });
    await typeIntoEditor("latest body");
    await renameTo("meeting notes");
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));

    let flushed = false;
    const flush = handleRef.current!.flushPendingSave().then(() => {
      flushed = true;
    });
    await act(async () => {});
    expect(flushed).toBe(false);

    await act(async () => {
      finishRename();
      await flush;
    });
    expect(flushed).toBe(true);
    expect(saveDocumentContent.mock.calls[0]![0]).toEqual({
      source: "document",
      assistantId: "asst-1",
      surfaceId: "surf-1",
      conversationId: "conv-1",
      title: "meeting notes",
    });
    expect(saveDocumentContent.mock.calls[0]![1]).toBe("latest body");
  });

  test("an autosave queued behind a failed rename uses the restored title", async () => {
    let failRename: () => void = () => {};
    saveDocumentContent.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failRename = () => reject(new Error("rename failed"));
        }),
    );
    renderViewer();
    await typeIntoEditor("body at rename");
    await renameTo("meeting notes");
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));

    await typeIntoEditor("edited during rename");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(saveDocumentContent).toHaveBeenCalledTimes(1);

    await act(async () => {
      failRename();
    });
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(2));

    expect(saveDocumentContent.mock.calls[1]![0]).toEqual({
      source: "document",
      assistantId: "asst-1",
      surfaceId: "surf-1",
      conversationId: "conv-1",
      title: "notes.md",
    });
    expect(saveDocumentContent.mock.calls[1]![1]).toBe(
      "edited during rename",
    );
  });

  test("a failed rename cannot roll back a newer rename", async () => {
    let failFirstRename: () => void = () => {};
    let finishSecondRename: () => void = () => {};
    saveDocumentContent
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failFirstRename = () => reject(new Error("rename failed"));
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecondRename = () =>
              resolve({ success: true } as unknown);
          }),
      );
    const onRenamed = mock((_documentName: string) => {});
    renderViewer({ onRenamed });

    await renameTo("first name");
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    await renameTo("final name");
    expect(saveDocumentContent).toHaveBeenCalledTimes(1);

    await act(async () => {
      failFirstRename();
    });
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(2));
    await act(async () => {
      finishSecondRename();
    });
    await typeIntoEditor("body after renames");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(3));

    expect(onRenamed.mock.calls.map((call) => call[0])).toEqual([
      "first name",
      "final name",
    ]);
    expect(saveDocumentContent.mock.calls[2]![0]).toEqual({
      source: "document",
      assistantId: "asst-1",
      surfaceId: "surf-1",
      conversationId: "conv-1",
      title: "final name",
    });
  });

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
