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

const { markdownWordCount, saveDocumentContent } = await import(
  "@/domains/chat/api/document-save"
);

beforeEach(() => {
  documentsPost.mockClear();
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
