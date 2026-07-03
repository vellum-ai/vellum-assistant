import { afterAll, describe, expect, mock, test } from "bun:test";

import type { SparseEmbedding } from "../embeddings/embedding-types.js";
import type { MessageLexicalSearchResult } from "../embeddings/messages-lexical-index.js";

const SPARSE: SparseEmbedding = { indices: [1, 2, 3], values: [0.5, 0.5, 0.5] };
const EMPTY_SPARSE: SparseEmbedding = { indices: [], values: [] };

// Mirror the real encoder: input that tokenizes to nothing (only whitespace
// or punctuation) yields an empty sparse vector.
const generateSparseEmbeddingMock = mock(
  (text: string): SparseEmbedding =>
    /[\p{L}\p{N}]/u.test(text) ? SPARSE : EMPTY_SPARSE,
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

// `embedding-backend` is mocked WITHOUT spreading the real module: importing
// it transitively pulls provider/security modules (and `packages/service-
// contracts` → `zod`) into the test for no benefit. The helper only imports
// `generateSparseEmbedding`, so a targeted replacement is complete for this
// file's needs.
mock.module("../embeddings/embedding-backend.js", () => ({
  generateSparseEmbedding: generateSparseEmbeddingMock,
}));

// `messages-lexical-index` IS spread from the real module. Bun's
// `mock.module` is process-global and is not undone by `mock.restore()`, so a
// partial replacement would drop the module's other real exports
// (`messagePointId`, `initMessagesLexicalIndex`, `MessagesLexicalIndex`, …)
// for any test that runs later in the same process (e.g.
// `embeddings/__tests__/messages-lexical-index.test.ts`, which imports
// `messagePointId`). Spreading keeps those intact; its deps
// (`@qdrant/js-client-rest`, `uuid`) are installed, so importing it is safe.
const actualLexicalIndex =
  await import("../embeddings/messages-lexical-index.js");
mock.module("../embeddings/messages-lexical-index.js", () => ({
  ...actualLexicalIndex,
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

  test("returns [] without querying the index for an empty-after-tokenize query", async () => {
    searchLexicalMock.mockClear();

    const results = await searchMessageIdsLexical("   ... !!! ", 5);

    expect(results).toEqual([]);
    // The empty sparse vector must never reach Qdrant.
    expect(searchLexicalMock).not.toHaveBeenCalled();
  });
});
