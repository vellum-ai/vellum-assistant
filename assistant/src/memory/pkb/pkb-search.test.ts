import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../__tests__/helpers/mock-logger.js";
import { _setOverridesForTesting } from "../../config/assistant-feature-flags.js";

// This test exercises the v1 PKB search path. The `memory-v2-enabled` flag
// (registry default `true`) makes pkb-search short-circuit to keep traffic
// off the legacy collection — disable it so the v1 path stays under test.
_setOverridesForTesting({ "memory-v2-enabled": false });

mock.module("../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
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

type Payload = {
  target_type: string;
  target_id: string;
  path?: string;
  text?: string;
};
type ScoredPoint = { id: string; score: number; payload: Payload };

let hybridResults: ScoredPoint[] = [];
let denseResults: ScoredPoint[] = [];
let hybridThrows: Error | null = null;
let denseThrows: Error | null = null;

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
      if (hybridThrows) throw hybridThrows;
      return hybridResults;
    },
    search: async (
      vector: number[],
      limit: number,
      filter?: Record<string, unknown>,
    ) => {
      searchCalls.push({ vector, limit, filter });
      if (denseThrows) throw denseThrows;
      return denseResults;
    },
  }),
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

const { searchPkbFiles } = await import("./pkb-search.js");

describe("searchPkbFiles", () => {
  beforeEach(() => {
    breakerOpen = false;
    hybridSearchCalls.length = 0;
    searchCalls.length = 0;
    hybridResults = [];
    denseResults = [];
    hybridThrows = null;
    denseThrows = null;
  });

  test("filter payload targets pkb_file (hybrid path runs both queries)", async () => {
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
    hybridResults = [
      {
        id: "a",
        score: 0.03,
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
    expect(searchCalls).toHaveLength(1);
    const filter = hybridSearchCalls[0]?.filter as {
      must: Array<Record<string, unknown>>;
    };
    const targetTypeClause = filter.must.find(
      (c) => c.key === "target_type",
    ) as { match: { value: string } } | undefined;
    expect(targetTypeClause?.match.value).toBe("pkb_file");
  });

  test("dense-only path: no sparse vector, no hybrid query", async () => {
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

    const results = await searchPkbFiles([0.1, 0.2, 0.3], undefined, 5);

    expect(searchCalls).toHaveLength(1);
    expect(hybridSearchCalls).toHaveLength(0);
    expect(results).toHaveLength(1);
    expect(results[0]?.denseScore).toBe(0.8);
    expect(results[0]?.hybridScore).toBeUndefined();

    const filter = searchCalls[0]?.filter as {
      must: Array<Record<string, unknown>>;
    };
    const targetTypeClause = filter.must.find(
      (c) => c.key === "target_type",
    ) as { match: { value: string } } | undefined;
    expect(targetTypeClause?.match.value).toBe("pkb_file");
  });

  test("both search paths exclude _meta sentinel points", async () => {
    // Hybrid path
    hybridResults = [];
    denseResults = [];
    await searchPkbFiles([0.1], { indices: [1], values: [1] }, 5);
    const hybridFilter = hybridSearchCalls[0]?.filter as {
      must_not: Array<Record<string, unknown>>;
    };
    const hybridMetaClause = hybridFilter.must_not.find(
      (c) => c.key === "_meta",
    ) as { match: { value: boolean } } | undefined;
    expect(hybridMetaClause?.match.value).toBe(true);

    const denseSideFilter = searchCalls[0]?.filter as {
      must_not: Array<Record<string, unknown>>;
    };
    const denseSideMetaClause = denseSideFilter.must_not.find(
      (c) => c.key === "_meta",
    ) as { match: { value: boolean } } | undefined;
    expect(denseSideMetaClause?.match.value).toBe(true);

    // Dense-only path (no sparse vector)
    searchCalls.length = 0;
    hybridSearchCalls.length = 0;
    denseResults = [];
    await searchPkbFiles([0.1], undefined, 5);
    const denseFilter = searchCalls[0]?.filter as {
      must_not: Array<Record<string, unknown>>;
    };
    const denseMetaClause = denseFilter.must_not.find(
      (c) => c.key === "_meta",
    ) as { match: { value: boolean } } | undefined;
    expect(denseMetaClause?.match.value).toBe(true);
  });

  test("chunks on the same path collapse to the highest score per query", async () => {
    denseResults = [
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
    hybridResults = [
      {
        id: "chunk-2",
        score: 0.03,
        payload: {
          target_type: "pkb_file",
          target_id: "t-2",
          path: "/notes/same.md",
        },
      },
      {
        id: "chunk-1",
        score: 0.02,
        payload: {
          target_type: "pkb_file",
          target_id: "t-1",
          path: "/notes/same.md",
        },
      },
    ];

    const results = await searchPkbFiles(
      [0.1, 0.2, 0.3],
      { indices: [1], values: [1] },
      10,
    );

    const same = results.find((r) => r.path === "/notes/same.md");
    const other = results.find((r) => r.path === "/notes/other.md");
    expect(same?.denseScore).toBe(0.9);
    expect(same?.hybridScore).toBe(0.03);
    expect(other?.denseScore).toBe(0.7);
    expect(other?.hybridScore).toBeUndefined();
  });

  test("propagates snippet from the best matching chunk without changing ranking", async () => {
    denseResults = [
      {
        id: "chunk-1",
        score: 0.9,
        payload: {
          target_type: "pkb_file",
          target_id: "t-1",
          path: "/notes/same.md",
          text: "Dense best chunk.",
        },
      },
      {
        id: "chunk-2",
        score: 0.5,
        payload: {
          target_type: "pkb_file",
          target_id: "t-2",
          path: "/notes/same.md",
          text: "Dense weaker chunk.",
        },
      },
      {
        id: "chunk-3",
        score: 0.7,
        payload: {
          target_type: "pkb_file",
          target_id: "t-3",
          path: "/notes/other.md",
          text: "Other dense chunk.",
        },
      },
    ];
    hybridResults = [
      {
        id: "chunk-2",
        score: 0.04,
        payload: {
          target_type: "pkb_file",
          target_id: "t-2",
          path: "/notes/same.md",
          text: "Hybrid best chunk.",
        },
      },
      {
        id: "chunk-1",
        score: 0.02,
        payload: {
          target_type: "pkb_file",
          target_id: "t-1",
          path: "/notes/same.md",
          text: "Hybrid weaker chunk.",
        },
      },
    ];

    const results = await searchPkbFiles(
      [0.1],
      { indices: [1], values: [1] },
      10,
    );

    expect(results.map((r) => r.path)).toEqual([
      "/notes/same.md",
      "/notes/other.md",
    ]);
    const same = results.find((r) => r.path === "/notes/same.md");
    const other = results.find((r) => r.path === "/notes/other.md");
    expect(same?.denseScore).toBe(0.9);
    expect(same?.hybridScore).toBe(0.04);
    expect(same?.snippet).toBe("Hybrid best chunk.");
    expect(other?.snippet).toBe("Other dense chunk.");
  });

  test("hybrid-only hits (no dense match) are dropped so they can't evict dense-qualified paths before the slice", async () => {
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
    // `b` appears only in the hybrid response (outside the dense prefetch).
    // It has no cosine score, so it can never pass a downstream threshold
    // and must not be surfaced — otherwise it could crowd out dense-qualified
    // hits before the caller gates on denseScore.
    hybridResults = [
      {
        id: "a",
        score: 0.03,
        payload: {
          target_type: "pkb_file",
          target_id: "t-1",
          path: "/notes/a.md",
        },
      },
      {
        id: "b",
        score: 0.02,
        payload: {
          target_type: "pkb_file",
          target_id: "t-2",
          path: "/notes/b.md",
        },
      },
    ];

    const results = await searchPkbFiles(
      [0.1],
      { indices: [1], values: [1] },
      10,
    );

    expect(results).toHaveLength(1);
    const a = results.find((r) => r.path === "/notes/a.md");
    expect(a?.denseScore).toBe(0.8);
    expect(a?.hybridScore).toBe(0.03);
    expect(results.find((r) => r.path === "/notes/b.md")).toBeUndefined();
  });

  test("hybrid failure (transient) falls back to dense-only results", async () => {
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
    hybridThrows = new Error("qdrant hybrid transient failure");

    const results = await searchPkbFiles(
      [0.1],
      { indices: [1], values: [1] },
      10,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("/notes/a.md");
    expect(results[0]?.denseScore).toBe(0.8);
    expect(results[0]?.hybridScore).toBeUndefined();
  });

  test("dense failure (transient) falls back to empty results even if hybrid succeeded", async () => {
    denseThrows = new Error("qdrant dense transient failure");
    hybridResults = [
      {
        id: "a",
        score: 0.03,
        payload: {
          target_type: "pkb_file",
          target_id: "t-1",
          path: "/notes/a.md",
        },
      },
    ];

    // Without a dense cosine score there is nothing to gate on, so the
    // hybrid-only fallback surfaces no results.
    const results = await searchPkbFiles(
      [0.1],
      { indices: [1], values: [1] },
      10,
    );

    expect(results).toEqual([]);
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

  test("caps results at limit and sorts by hybrid score desc when available", async () => {
    denseResults = [
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
    // Hybrid puts c ahead of b (lexical match) — ranking should follow hybrid.
    hybridResults = [
      {
        id: "c",
        score: 0.04,
        payload: {
          target_type: "pkb_file",
          target_id: "t-3",
          path: "/c.md",
        },
      },
      {
        id: "b",
        score: 0.02,
        payload: {
          target_type: "pkb_file",
          target_id: "t-2",
          path: "/b.md",
        },
      },
    ];

    const results = await searchPkbFiles(
      [0.1],
      { indices: [1], values: [1] },
      2,
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.path).toBe("/c.md");
    expect(results[1]?.path).toBe("/b.md");
  });

  test("dense-only path sorts by denseScore when no sparse provided", async () => {
    denseResults = [
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
    ];

    const results = await searchPkbFiles([0.1], undefined, 5);
    expect(results[0]?.path).toBe("/b.md");
    expect(results[1]?.path).toBe("/a.md");
  });

  test("adds memory_scope_id clause when scopeIds provided (both queries)", async () => {
    hybridResults = [];
    denseResults = [];

    await searchPkbFiles([0.1], { indices: [1], values: [1] }, 5, [
      "scope-a",
      "scope-b",
    ]);

    const hybridFilter = hybridSearchCalls[0]?.filter as {
      must: Array<Record<string, unknown>>;
    };
    const denseFilter = searchCalls[0]?.filter as {
      must: Array<Record<string, unknown>>;
    };
    for (const filter of [hybridFilter, denseFilter]) {
      const scopeClause = filter.must.find(
        (c) => c.key === "memory_scope_id",
      ) as { match: { any: string[] } } | undefined;
      expect(scopeClause?.match.any).toEqual(["scope-a", "scope-b"]);
    }
  });
});
