/**
 * The document editor autosaves through one endpoint, so the guarantee under
 * test is that the save carries the document's identity and the word count the
 * documents API stores.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const documentsPost = mock(async (_options: unknown) => ({
  data: {},
  error: undefined,
  response: { ok: true } as Response,
}));

const daemonSdk = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  documentsPost,
}));

const {
  markdownWordCount,
  saveDocumentContent,
  trackDocumentSave,
  waitForDocumentSaves,
} = await import("@/domains/chat/api/document-save");

beforeEach(() => {
  documentsPost.mockClear();
});

describe("document save waits", () => {
  const target = { assistantId: "assistant-1", surfaceId: "surface-1" };

  function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  test("waits only for the matching assistant and surface", async () => {
    const write = deferred();
    trackDocumentSave(target, write.promise);
    const done = mock(() => {});
    const waiting = waitForDocumentSaves(target).then(done);
    await waitForDocumentSaves({ ...target, assistantId: "assistant-2" });
    await waitForDocumentSaves({ ...target, surfaceId: "surface-2" });
    expect(done).not.toHaveBeenCalled();
    write.resolve();
    await waiting;
    expect(done).toHaveBeenCalledTimes(1);
    await waitForDocumentSaves(target);
  });

  test("includes another drain registered while a prior drain is pending", async () => {
    const first = deferred();
    const second = deferred();
    trackDocumentSave(target, first.promise);
    const done = mock(() => {});
    const waiting = waitForDocumentSaves(target).then(done);
    trackDocumentSave(target, second.promise);
    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    second.resolve();
    await waiting;
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("a failed drain rejects its waiter and releases the entry for retry", async () => {
    const write = deferred();
    trackDocumentSave(target, write.promise);
    const waiting = waitForDocumentSaves(target);
    write.reject(new Error("offline"));
    await expect(waiting).rejects.toThrow("offline");
    await waitForDocumentSaves(target);
  });
});

describe("markdownWordCount", () => {
  test("counts words and ignores surrounding whitespace", () => {
    expect(markdownWordCount("  # Two  words \n")).toBe(3);
  });

  test("counts an empty document as no words", () => {
    expect(markdownWordCount("   ")).toBe(0);
  });
});

describe("saveDocumentContent", () => {
  test("a document is saved through the documents API", async () => {
    await saveDocumentContent(
      {
        source: "document",
        assistantId: "asst-1",
        surfaceId: "surf-1",
        conversationId: "conv-1",
        title: "Plan",
      },
      "# Plan\nship it",
    );

    expect(documentsPost).toHaveBeenCalledTimes(1);
    expect(documentsPost.mock.calls[0]![0]).toMatchObject({
      path: { assistant_id: "asst-1" },
      body: {
        surfaceId: "surf-1",
        conversationId: "conv-1",
        title: "Plan",
        content: "# Plan\nship it",
        wordCount: 4,
      },
    });
  });

  test("a rejected save rejects", async () => {
    documentsPost.mockImplementationOnce(() =>
      Promise.reject(new Error("denied")),
    );

    await expect(
      saveDocumentContent(
        {
          source: "document",
          assistantId: "asst-1",
          surfaceId: "surf-1",
          conversationId: "conv-1",
          title: "Plan",
        },
        "# Plan",
      ),
    ).rejects.toThrow("denied");
  });
});
