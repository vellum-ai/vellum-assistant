import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

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

mock.module("../qdrant-circuit-breaker.js", () => ({
  isQdrantBreakerOpen: () => breakerOpen,
  withQdrantBreaker: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  shouldAllowQdrantProbe: () => true,
  _resetQdrantBreaker: () => {},
  QdrantCircuitOpenError: class extends Error {},
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
      return [];
    },
    search: async (
      vector: number[],
      limit: number,
      filter?: Record<string, unknown>,
    ) => {
      searchCalls.push({ vector, limit, filter });
      return [];
    },
  }),
  initQdrantClient: () => {},
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
  VellumQdrantClient: class {},
}));

const { searchGraphNodes } = await import("./graph-search.js");

describe("searchGraphNodes — _meta filter parity", () => {
  beforeEach(() => {
    breakerOpen = false;
    hybridSearchCalls.length = 0;
    searchCalls.length = 0;
  });

  test("hybrid path excludes _meta sentinel points", async () => {
    await searchGraphNodes([0.1], 5, ["default"], {
      indices: [1],
      values: [1],
    });

    expect(hybridSearchCalls).toHaveLength(1);
    const filter = hybridSearchCalls[0]?.filter as {
      must_not: Array<Record<string, unknown>>;
    };
    const metaClause = filter.must_not.find((c) => c.key === "_meta") as
      | { match: { value: boolean } }
      | undefined;
    expect(metaClause?.match.value).toBe(true);
  });

  test("dense-only path also excludes _meta sentinel points", async () => {
    await searchGraphNodes([0.1], 5, ["default"]);

    expect(searchCalls).toHaveLength(1);
    const filter = searchCalls[0]?.filter as {
      must_not: Array<Record<string, unknown>>;
    };
    const metaClause = filter.must_not.find((c) => c.key === "_meta") as
      | { match: { value: boolean } }
      | undefined;
    expect(metaClause?.match.value).toBe(true);
  });
});

describe("searchGraphNodes — excludeScopeIds", () => {
  beforeEach(() => {
    breakerOpen = false;
    hybridSearchCalls.length = 0;
    searchCalls.length = 0;
  });

  test("hybrid path adds memory_scope_id must_not when excludeScopeIds provided", async () => {
    await searchGraphNodes(
      [0.1],
      5,
      undefined,
      { indices: [1], values: [1] },
      undefined,
      ["scope:abc", "scope:xyz"],
    );

    expect(hybridSearchCalls).toHaveLength(1);
    const filter = hybridSearchCalls[0]?.filter as {
      must_not: Array<Record<string, unknown>>;
    };
    const scopeExclude = filter.must_not.find(
      (c) => c.key === "memory_scope_id",
    ) as { match: { any: string[] } } | undefined;
    expect(scopeExclude?.match.any).toEqual(["scope:abc", "scope:xyz"]);
  });

  test("dense-only path adds memory_scope_id must_not when excludeScopeIds provided", async () => {
    await searchGraphNodes([0.1], 5, undefined, undefined, undefined, [
      "scope:abc",
    ]);

    expect(searchCalls).toHaveLength(1);
    const filter = searchCalls[0]?.filter as {
      must_not: Array<Record<string, unknown>>;
    };
    const scopeExclude = filter.must_not.find(
      (c) => c.key === "memory_scope_id",
    ) as { match: { any: string[] } } | undefined;
    expect(scopeExclude?.match.any).toEqual(["scope:abc"]);
  });

  test("hybrid path omits memory_scope_id must_not when excludeScopeIds is empty", async () => {
    await searchGraphNodes(
      [0.1],
      5,
      undefined,
      { indices: [1], values: [1] },
      undefined,
      [],
    );

    expect(hybridSearchCalls).toHaveLength(1);
    const filter = hybridSearchCalls[0]?.filter as {
      must_not: Array<Record<string, unknown>>;
    };
    const scopeExclude = filter.must_not.find(
      (c) => c.key === "memory_scope_id",
    );
    expect(scopeExclude).toBeUndefined();
  });
});

describe("searchGraphNodes — prefetch floor", () => {
  beforeEach(() => {
    breakerOpen = false;
    hybridSearchCalls.length = 0;
    searchCalls.length = 0;
  });

  test("hybrid prefetchLimit floors at 200 for small limits", async () => {
    await searchGraphNodes([0.1], 10, ["default"], {
      indices: [1],
      values: [1],
    });

    expect(hybridSearchCalls).toHaveLength(1);
    expect(hybridSearchCalls[0]?.prefetchLimit).toBe(200);
  });

  test("hybrid prefetchLimit scales with limit when limit*10 exceeds floor", async () => {
    await searchGraphNodes([0.1], 50, ["default"], {
      indices: [1],
      values: [1],
    });

    expect(hybridSearchCalls).toHaveLength(1);
    expect(hybridSearchCalls[0]?.prefetchLimit).toBe(500);
  });
});
