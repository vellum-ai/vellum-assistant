import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Mutable breaker state + capture buffers for assertions.
let breakerOpen = false;
const hybridSearchCalls: Array<{
  denseVector: number[];
  sparseVector: { indices: number[]; values: number[] };
  filter?: unknown;
  limit: number;
  prefetchLimit?: number;
}> = [];
const searchCalls: Array<{
  vector: number[];
  limit: number;
  filter?: unknown;
}> = [];

type Payload = { target_type: string; target_id: string; path?: string };
type ScoredPoint = { id: string; score: number; payload: Payload };

let hybridResults: ScoredPoint[] = [];
let denseResults: ScoredPoint[] = [];

mock.module("../qdrant-circuit-breaker.js", () => ({
  isQdrantBreakerOpen: () => breakerOpen,
  withQdrantBreaker: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

mock.module("../qdrant-client.js", () => ({
  getQdrantClient: () => ({
    hybridSearch: async (params: {
      denseVector: number[];
      sparseVector: { indices: number[]; values: number[] };
      filter?: unknown;
      limit: number;
      prefetchLimit?: number;
    }) => {
      hybridSearchCalls.push(params);
      return hybridResults;
    },
    search: async (
      vector: number[],
      limit: number,
      filter?: Record<string, unknown>,
    ) => {
      searchCalls.push({ vector, limit, filter });
      return denseResults;
    },
  }),
}));

const { searchPkbFiles } = await import("./pkb-search.js");

describe("searchPkbFiles", () => {
  beforeEach(() => {
    breakerOpen = false;
    hybridSearchCalls.length = 0;
    searchCalls.length = 0;
    hybridResults = [];
    denseResults = [];
  });

  test("filter payload targets pkb_file (hybrid path)", async () => {
    hybridResults = [
      {
        id: "a",
        score: 0.9,
        payload: {
          target_type: "pkb_file",
          target_id: "t-1",
          path: "/notes/a.md",
        },
      },
    ];

    await searchPkbFiles(
      [0.1, 0.2, 0.3],
      { indices: [1, 2], values: [0.5, 0.5] },
      5,
    );

    expect(hybridSearchCalls).toHaveLength(1);
    const filter = hybridSearchCalls[0]?.filter as {
      must: Array<Record<string, unknown>>;
    };
    const targetTypeClause = filter.must.find(
      (c) => c.key === "target_type",
    ) as { match: { value: string } } | undefined;
    expect(targetTypeClause?.match.value).toBe("pkb_file");
  });

  test("filter payload targets pkb_file (dense-only path)", async () => {
    denseResults = [
      {
        id: "a",
        score: 0.8,
        payload: {
          target_type: "pkb_file",
          target_id: "t-1",
          path: "/notes/a.md",
        },
      },
    ];

    await searchPkbFiles([0.1, 0.2, 0.3], undefined, 5);

    expect(searchCalls).toHaveLength(1);
    const filter = searchCalls[0]?.filter as {
      must: Array<Record<string, unknown>>;
    };
    const targetTypeClause = filter.must.find(
      (c) => c.key === "target_type",
    ) as { match: { value: string } } | undefined;
    expect(targetTypeClause?.match.value).toBe("pkb_file");
  });

  test("two points on the same path collapse to the higher score", async () => {
    hybridResults = [
      {
        id: "chunk-1",
        score: 0.5,
        payload: {
          target_type: "pkb_file",
          target_id: "t-1",
          path: "/notes/same.md",
        },
      },
      {
        id: "chunk-2",
        score: 0.9,
        payload: {
          target_type: "pkb_file",
          target_id: "t-2",
          path: "/notes/same.md",
        },
      },
      {
        id: "chunk-3",
        score: 0.7,
        payload: {
          target_type: "pkb_file",
          target_id: "t-3",
          path: "/notes/other.md",
        },
      },
    ];

    const results = await searchPkbFiles(
      [0.1, 0.2, 0.3],
      { indices: [1], values: [1] },
      10,
    );

    expect(results).toHaveLength(2);
    const same = results.find((r) => r.path === "/notes/same.md");
    const other = results.find((r) => r.path === "/notes/other.md");
    expect(same?.score).toBe(0.9);
    expect(other?.score).toBe(0.7);
    // Sorted by score desc
    expect(results[0]?.path).toBe("/notes/same.md");
    expect(results[1]?.path).toBe("/notes/other.md");
  });

  test("empty Qdrant response yields []", async () => {
    hybridResults = [];
    denseResults = [];

    const hybrid = await searchPkbFiles(
      [0.1],
      { indices: [1], values: [1] },
      5,
    );
    expect(hybrid).toEqual([]);

    const dense = await searchPkbFiles([0.1], undefined, 5);
    expect(dense).toEqual([]);
  });

  test("returns [] when Qdrant circuit breaker is open", async () => {
    breakerOpen = true;
    hybridResults = [
      {
        id: "a",
        score: 1,
        payload: {
          target_type: "pkb_file",
          target_id: "t-1",
          path: "/notes/a.md",
        },
      },
    ];

    const results = await searchPkbFiles(
      [0.1, 0.2],
      { indices: [1], values: [1] },
      5,
    );

    expect(results).toEqual([]);
    expect(hybridSearchCalls).toHaveLength(0);
    expect(searchCalls).toHaveLength(0);
  });

  test("caps results at limit and sorts by score desc", async () => {
    hybridResults = [
      {
        id: "a",
        score: 0.3,
        payload: {
          target_type: "pkb_file",
          target_id: "t-1",
          path: "/a.md",
        },
      },
      {
        id: "b",
        score: 0.9,
        payload: {
          target_type: "pkb_file",
          target_id: "t-2",
          path: "/b.md",
        },
      },
      {
        id: "c",
        score: 0.6,
        payload: {
          target_type: "pkb_file",
          target_id: "t-3",
          path: "/c.md",
        },
      },
    ];

    const results = await searchPkbFiles(
      [0.1],
      { indices: [1], values: [1] },
      2,
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.path).toBe("/b.md");
    expect(results[1]?.path).toBe("/c.md");
  });

  test("adds memory_scope_id clause when scopeIds provided", async () => {
    hybridResults = [];

    await searchPkbFiles(
      [0.1],
      { indices: [1], values: [1] },
      5,
      ["scope-a", "scope-b"],
    );

    const filter = hybridSearchCalls[0]?.filter as {
      must: Array<Record<string, unknown>>;
    };
    const scopeClause = filter.must.find(
      (c) => c.key === "memory_scope_id",
    ) as { match: { any: string[] } } | undefined;
    expect(scopeClause?.match.any).toEqual(["scope-a", "scope-b"]);
  });
});
