import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import type * as DocumentSave from "@/domains/chat/api/document-save";
import type { DocumentSaveTarget } from "@/domains/chat/api/document-save";
import type * as CaptureError from "@/lib/sentry/capture-error";

const saveDocumentContent = mock(
  async (_target: DocumentSaveTarget, _markdown: string): Promise<void> => {},
);
const captureError = mock(() => {});
const documentSave = await import("@/domains/chat/api/document-save");
mock.module(
  "@/domains/chat/api/document-save",
  (): Partial<typeof DocumentSave> => ({
    ...documentSave,
    saveDocumentContent,
  }),
);
mock.module(
  "@/lib/sentry/capture-error",
  (): Partial<typeof CaptureError> => ({ captureError }),
);

const { useDocumentEditorSave } = await import("./use-document-editor-save");

const TARGET: DocumentSaveTarget = {
  source: "document",
  assistantId: "assistant-1",
  surfaceId: "surface-1",
  conversationId: "conversation-1",
  title: "Notes",
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function renderSave() {
  const onRenamed = mock((_title: string) => {});
  const onRenameSaved = mock((_target: DocumentSaveTarget) => {});
  const onRenameFailed = mock((_error: unknown) => {});
  const hook = renderHook(
    ({ target, content }) =>
      useDocumentEditorSave({
        target,
        content,
        onRenamed,
        onRenameSaved,
        onRenameFailed,
      }),
    { initialProps: { target: TARGET, content: "Original body" } },
  );
  return { ...hook, onRenamed, onRenameSaved, onRenameFailed };
}

beforeEach(() => {
  saveDocumentContent.mockReset();
  saveDocumentContent.mockImplementation(async () => {});
  captureError.mockClear();
});

afterEach(async () => {
  cleanup();
  await act(async () => {});
});

describe("useDocumentEditorSave", () => {
  test.each(["success", "failure"])(
    "a detached rename reports only cache-safe %s callbacks",
    async (outcome) => {
      const write = deferred();
      saveDocumentContent.mockImplementationOnce(() => write.promise);
      const { result, unmount, onRenamed, onRenameSaved, onRenameFailed } =
        renderSave();
      act(() => result.current.rename("Renamed notes"));
      await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
      unmount();
      await act(async () => {
        if (outcome === "success") {
          write.resolve();
        } else {
          write.reject(new Error("offline"));
        }
      });
      if (outcome === "success") {
        expect(onRenameSaved).toHaveBeenCalledWith({
          ...TARGET,
          title: "Renamed notes",
        });
      } else {
        expect(onRenameSaved).not.toHaveBeenCalled();
        expect(captureError).toHaveBeenCalled();
      }
      expect(onRenamed.mock.calls).toEqual([["Renamed notes"]]);
      expect(onRenameFailed).not.toHaveBeenCalled();
      expect(saveDocumentContent).toHaveBeenCalledTimes(1);
    },
  );

  test("rename completion identifies the write target even after the link changes", async () => {
    const write = deferred();
    saveDocumentContent.mockImplementationOnce(() => write.promise);
    const { result, rerender, onRenameSaved } = renderSave();
    act(() => result.current.rename("Renamed notes"));
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    rerender({
      target: { ...TARGET, conversationId: "conversation-2" },
      content: "Original body",
    });
    await act(async () => write.resolve());
    expect(onRenameSaved).toHaveBeenCalledWith({
      ...TARGET,
      title: "Renamed notes",
    });
  });

  test("a superseded rename still refreshes caches if its newer replacement fails", async () => {
    const first = deferred();
    const second = deferred();
    saveDocumentContent
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result, onRenameSaved } = renderSave();
    act(() => result.current.rename("First title"));
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    act(() => result.current.rename("Second title"));
    await act(async () => first.resolve());
    expect(onRenameSaved).toHaveBeenCalledWith({
      ...TARGET,
      title: "First title",
    });
    await act(async () => second.reject(new Error("offline")));
    expect(onRenameSaved).toHaveBeenCalledTimes(1);
    expect(result.current.title).toBe("First title");
  });

  test("flush returns the current snapshot without writing an unchanged document", async () => {
    const { result } = renderSave();
    await act(async () => {
      expect(await result.current.flushPendingSave()).toEqual({
        title: "Notes",
        content: "Original body",
      });
    });
    expect(saveDocumentContent).not.toHaveBeenCalled();
  });

  test("drains edits made during an in-flight save in order", async () => {
    const first = deferred();
    saveDocumentContent.mockImplementationOnce(() => first.promise);
    const { result } = renderSave();
    act(() => result.current.changeContent("First edit"));
    const saved = result.current.flushPendingSave();
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    act(() => result.current.changeContent("Latest edit"));
    expect(saveDocumentContent).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve();
      expect(await saved).toEqual({ title: "Notes", content: "Latest edit" });
    });
    expect(saveDocumentContent.mock.calls.map((call) => call[1])).toEqual([
      "First edit",
      "Latest edit",
    ]);
  });

  test("rename waits behind a body save and carries the latest body", async () => {
    const first = deferred();
    saveDocumentContent.mockImplementationOnce(() => first.promise);
    const { result, onRenameSaved } = renderSave();
    act(() => result.current.changeContent("First edit"));
    const saved = result.current.flushPendingSave();
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.changeContent("Latest edit");
      result.current.rename("Renamed notes");
    });
    expect(saveDocumentContent).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve();
      expect(await saved).toEqual({
        title: "Renamed notes",
        content: "Latest edit",
      });
    });
    expect(saveDocumentContent.mock.calls[1]).toEqual([
      { ...TARGET, title: "Renamed notes" },
      "Latest edit",
    ]);
    expect(onRenameSaved).toHaveBeenCalledTimes(1);
  });

  test.each(["body", "rename", "close"])(
    "drains a newer %s revision after the in-flight write fails",
    async (trigger) => {
      const first = deferred();
      const latest = deferred();
      saveDocumentContent
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => latest.promise);
      const { result, unmount, onRenameSaved } = renderSave();
      act(() => result.current.changeContent("First edit"));
      const firstFlush = result.current.flushPendingSave().catch(() => {});
      await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
      act(() => {
        result.current.changeContent("Latest edit");
        if (trigger === "rename") {
          result.current.rename("Latest title");
        }
      });
      if (trigger === "body") {
        // Let the debounce consume its trigger while the first write is pending.
        await act(
          async () => new Promise((resolve) => setTimeout(resolve, 1100)),
        );
      } else if (trigger === "close") {
        unmount();
      }
      await act(async () => first.reject(new Error("First write failed")));
      await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(2));
      expect(saveDocumentContent.mock.calls[1]).toEqual([
        { ...TARGET, title: trigger === "rename" ? "Latest title" : "Notes" },
        "Latest edit",
      ]);
      if (trigger !== "close") {
        expect(result.current.saveStatus).toBe("saving");
      }
      await act(async () => {
        latest.resolve();
        await firstFlush;
      });
      if (trigger === "rename") {
        expect(onRenameSaved).toHaveBeenCalledTimes(1);
      }
      if (trigger !== "close") {
        expect(result.current.saveStatus).toBe("saved");
      }
      expect(saveDocumentContent).toHaveBeenCalledTimes(2);
    },
  );

  test("a failed latest revision rejects instead of repeatedly retrying itself", async () => {
    const first = deferred();
    saveDocumentContent
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValueOnce(new Error("Still offline"));
    const { result } = renderSave();
    act(() => result.current.rename("First title"));
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    act(() => result.current.rename("Latest title"));
    await act(async () => first.reject(new Error("First write failed")));
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(2));
    expect(captureError).toHaveBeenCalled();
    expect(result.current.saveStatus).toBe("idle");
  });

  test("a failed save rejects preparation and retains its body for retry", async () => {
    saveDocumentContent.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderSave();
    act(() => result.current.changeContent("Keep this edit"));
    let lease!: ReturnType<typeof result.current.beginSendPreparation>;
    act(() => {
      lease = result.current.beginSendPreparation();
    });
    await act(async () => {
      await expect(lease.flush()).rejects.toThrow("offline");
      lease.release();
    });
    expect(result.current.editingLocked).toBe(false);
    await act(async () => {
      expect(await result.current.flushPendingSave()).toEqual({
        title: "Notes",
        content: "Keep this edit",
      });
    });
    expect(saveDocumentContent.mock.calls.map((call) => call[1])).toEqual([
      "Keep this edit",
      "Keep this edit",
    ]);
  });

  test("failed rename restores the persisted title without dropping body edits", async () => {
    saveDocumentContent.mockRejectedValueOnce(new Error("offline"));
    const { result, onRenamed, onRenameFailed } = renderSave();
    act(() => {
      result.current.changeContent("Keep this edit");
      result.current.rename("Temporary title");
    });
    await waitFor(() => expect(onRenameFailed).toHaveBeenCalledTimes(1));
    expect(onRenamed.mock.calls).toEqual([["Temporary title"], ["Notes"]]);
    await act(async () => {
      expect(await result.current.flushPendingSave()).toEqual({
        title: "Notes",
        content: "Keep this edit",
      });
    });
    expect(saveDocumentContent.mock.calls[1]).toEqual([
      TARGET,
      "Keep this edit",
    ]);
  });

  test("a failed older rename cannot roll back a newer title", async () => {
    const first = deferred();
    saveDocumentContent.mockImplementationOnce(() => first.promise);
    const { result, onRenamed } = renderSave();
    act(() => result.current.rename("First title"));
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    act(() => result.current.rename("Latest title"));
    await act(async () => first.reject(new Error("offline")));
    expect(onRenamed.mock.calls).toEqual([["First title"], ["Latest title"]]);
    expect(saveDocumentContent.mock.calls[1]).toEqual([
      { ...TARGET, title: "Latest title" },
      "Original body",
    ]);
    await act(async () => {
      expect(await result.current.flushPendingSave()).toEqual({
        title: "Latest title",
        content: "Original body",
      });
    });
  });

  test("preparation locks body edits and renames until every lease is released", async () => {
    const { result } = renderSave();
    let first!: ReturnType<typeof result.current.beginSendPreparation>;
    let second!: ReturnType<typeof result.current.beginSendPreparation>;
    act(() => {
      result.current.changeContent("Prepared body");
      first = result.current.beginSendPreparation();
      second = result.current.beginSendPreparation();
      result.current.changeContent("Blocked edit");
      result.current.rename("Blocked title");
    });
    expect(result.current.editingLocked).toBe(true);
    await act(async () => {
      expect(await first.flush()).toEqual({
        title: "Notes",
        content: "Prepared body",
      });
      first.release();
    });
    expect(result.current.editingLocked).toBe(true);
    expect(first.isCurrent()).toBe(false);
    act(() => second.release());
    expect(result.current.editingLocked).toBe(false);
    act(() => result.current.changeContent("After release"));
    await act(async () => {
      expect((await result.current.flushPendingSave()).content).toBe(
        "After release",
      );
    });
  });

  test("released or unmounted preparation cannot be used to send", async () => {
    const first = deferred();
    saveDocumentContent.mockImplementationOnce(() => first.promise);
    const { result, unmount } = renderSave();
    const oldHandle = result.current;
    act(() => oldHandle.changeContent("Last edit"));
    let lease!: ReturnType<typeof result.current.beginSendPreparation>;
    act(() => {
      lease = oldHandle.beginSendPreparation();
    });
    const preparing = lease.flush().catch((error: unknown) => error);
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    unmount();
    expect(lease.isCurrent()).toBe(false);
    first.resolve();
    expect(await preparing).toBeInstanceOf(Error);
    expect(oldHandle.beginSendPreparation().isCurrent()).toBe(false);
    await expect(oldHandle.flushPendingSave()).rejects.toThrow(
      "no longer active",
    );
    expect(saveDocumentContent.mock.calls[0]).toEqual([TARGET, "Last edit"]);
  });

  test("incoming snapshots do not overwrite local changes while a save is pending", async () => {
    const first = deferred();
    saveDocumentContent.mockImplementationOnce(() => first.promise);
    const { result, rerender } = renderSave();
    act(() => result.current.changeContent("Local latest"));
    const saved = result.current.flushPendingSave();
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(1));
    rerender({ target: TARGET, content: "Stale fetched body" });
    expect(result.current.editorContent).toBe("Original body");
    await act(async () => {
      first.resolve();
      expect((await saved).content).toBe("Local latest");
    });
    rerender({ target: TARGET, content: "Stale fetched body" });
    await act(async () => {
      expect((await result.current.flushPendingSave()).content).toBe(
        "Local latest",
      );
    });
    rerender({ target: TARGET, content: "New assistant edit" });
    expect(result.current.editorContent).toBe("New assistant edit");
  });

  test("a linked conversation update changes subsequent writes without losing edits", async () => {
    const { result, rerender } = renderSave();
    act(() => result.current.changeContent("Pending edit"));
    rerender({
      target: { ...TARGET, conversationId: "conversation-2" },
      content: "Original body",
    });
    await act(async () => result.current.flushPendingSave());
    expect(saveDocumentContent.mock.calls[0]).toEqual([
      { ...TARGET, conversationId: "conversation-2" },
      "Pending edit",
    ]);
  });

  test("a title-only prop change cannot restore the loaded body over saved edits", async () => {
    const { result, rerender } = renderSave();
    act(() => result.current.changeContent("Latest saved edit"));
    await act(async () => result.current.flushPendingSave());
    rerender({
      target: { ...TARGET, title: "Renamed externally" },
      content: "Original body",
    });
    await act(async () => {
      expect(await result.current.flushPendingSave()).toEqual({
        title: "Renamed externally",
        content: "Latest saved edit",
      });
    });
    act(() => result.current.rename("Renamed again"));
    await waitFor(() => expect(saveDocumentContent).toHaveBeenCalledTimes(2));
    expect(saveDocumentContent.mock.calls[1]![1]).toBe("Latest saved edit");
  });
});
