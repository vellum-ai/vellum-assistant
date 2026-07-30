/**
 * The document editor autosaves into two different stores, so the guarantee
 * under test is routing: a file-backed document never reaches the documents
 * API, and a db-backed document never rewrites a workspace file.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const documentsPost = mock(async (_options: unknown) => ({
  data: {},
  error: undefined,
  response: { ok: true } as Response,
}));
const workspaceWritePost = mock(async (_options: unknown) => ({
  data: {},
  error: undefined,
  response: { ok: true } as unknown as Response,
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

  test("a workspace file is saved by rewriting the file", async () => {
    await saveDocumentContent(
      {
        source: "workspace-file",
        assistantId: "asst-1",
        workspacePath: "drafts/notes.md",
      },
      "# Notes",
    );

    expect(documentsPost).not.toHaveBeenCalled();
    expect(workspaceWritePost).toHaveBeenCalledTimes(1);
    expect(workspaceWritePost.mock.calls[0]![0]).toMatchObject({
      path: { assistant_id: "asst-1" },
      body: {
        path: "drafts/notes.md",
        content: "# Notes",
        encoding: "utf8",
      },
    });
  });

  test("a rejected file write rejects", async () => {
    workspaceWritePost.mockImplementationOnce(async () => ({
      data: undefined as unknown as Record<string, never>,
      error: { message: "denied" } as unknown as undefined,
      response: { ok: false } as unknown as Response,
    }));

    await expect(
      saveDocumentContent(
        {
          source: "workspace-file",
          assistantId: "asst-1",
          workspacePath: "drafts/notes.md",
        },
        "# Notes",
      ),
    ).rejects.toThrow("Failed to save file");
  });
});
