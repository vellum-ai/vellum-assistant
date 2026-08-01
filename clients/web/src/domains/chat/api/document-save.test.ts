/**
 * The document editor autosaves through one endpoint, including for a document
 * bound to a workspace file — the daemon writes that one through to the file —
 * so the guarantee under test is that the save carries the document's identity
 * and never writes the workspace directly.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const documentsPost = mock(async (_options: unknown) => ({
  data: {},
  error: undefined,
  response: { ok: true } as Response,
}));
// Not called any more: proving that is the point of the routing tests below.
const workspaceWritePost = mock(async (_options: unknown) => ({
  data: {},
  error: undefined,
  response: ({ ok: true } as unknown) as Response,
}));

const daemonSdk = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  documentsPost,
  workspaceWritePost,
}));

const { markdownWordCount, saveDocumentContent } = await import(
  "@/domains/chat/api/document-save"
);

beforeEach(() => {
  documentsPost.mockClear();
  workspaceWritePost.mockClear();
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
  test("a db-backed document is saved through the documents API", async () => {
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

    expect(workspaceWritePost).not.toHaveBeenCalled();
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

  test("a file-backed document saves the same way, not by writing the file", async () => {
    await saveDocumentContent(
      {
        source: "document",
        assistantId: "asst-1",
        surfaceId: "surf-file",
        conversationId: "conv-1",
        title: "notes.md",
      },
      "# Notes",
    );

    // The daemon writes this document through to `drafts/notes.md` itself, so
    // the client must not race it with a workspace write of its own.
    expect(workspaceWritePost).not.toHaveBeenCalled();
    expect(documentsPost).toHaveBeenCalledTimes(1);
    expect(documentsPost.mock.calls[0]![0]).toMatchObject({
      body: { surfaceId: "surf-file", content: "# Notes" },
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
