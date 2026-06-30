import { afterAll, describe, expect, mock, test } from "bun:test";

import type { SparseEmbedding } from "../embeddings/embedding-types.js";
import type { MessageLexicalSearchResult } from "../embeddings/messages-lexical-index.js";

const SPARSE: SparseEmbedding = { indices: [1, 2, 3], values: [0.5, 0.5, 0.5] };

const generateSparseEmbeddingMock = mock(
  (_text: string): SparseEmbedding => SPARSE,
);

const searchLexicalMock = mock(
  async (
    _sparse: SparseEmbedding,
    _limit: number,
    _opts?: { conversationId?: string },
  ): Promise<MessageLexicalSearchResult[]> => [
    { messageId: "msg-1", score: 0.9 },
    { messageId: "msg-2", score: 0.4 },
  ],
);

const getMessagesLexicalIndexMock = mock(() => ({
  searchLexical: searchLexicalMock,
}));

// Mock both dependencies fully (no real-module spread): the helper imports
// only `generateSparseEmbedding` and `getMessagesLexicalIndex`, and importing
// the real `embedding-backend.js` would transitively pull provider/security
// modules into the test for no benefit.
mock.module("../embeddings/embedding-backend.js", () => ({
  generateSparseEmbedding: generateSparseEmbeddingMock,
}));

mock.module("../embeddings/messages-lexical-index.js", () => ({
  getMessagesLexicalIndex: getMessagesLexicalIndexMock,
}));

const { searchMessageIdsLexical } =
  await import("../conversation-search-lexical.js");

afterAll(() => {
  mock.restore();
});

describe("searchMessageIdsLexical", () => {
  test("encodes the query and returns the index results", async () => {
    generateSparseEmbeddingMock.mockClear();
    searchLexicalMock.mockClear();

    const results = await searchMessageIdsLexical("hello world", 5);

    expect(generateSparseEmbeddingMock).toHaveBeenCalledTimes(1);
    expect(generateSparseEmbeddingMock.mock.calls[0]).toEqual(["hello world"]);

    // The encoded sparse vector and limit are passed straight through.
    expect(searchLexicalMock).toHaveBeenCalledTimes(1);
    expect(searchLexicalMock.mock.calls[0]![0]).toBe(SPARSE);
    expect(searchLexicalMock.mock.calls[0]![1]).toBe(5);

    expect(results).toEqual([
      { messageId: "msg-1", score: 0.9 },
      { messageId: "msg-2", score: 0.4 },
    ]);
  });

  test("passes conversationId through to the index", async () => {
    searchLexicalMock.mockClear();

    await searchMessageIdsLexical("scoped", 3, { conversationId: "conv-xyz" });

    expect(searchLexicalMock).toHaveBeenCalledTimes(1);
    expect(searchLexicalMock.mock.calls[0]![2]).toEqual({
      conversationId: "conv-xyz",
    });
  });
});
