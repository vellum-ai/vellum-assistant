/**
 * Tests for `memory/v2/reranker.ts` — public `rerankCandidates` function.
 *
 * Mocks the underlying `LocalRerankBackend` and the `readPage` page reader so
 * the test is hermetic (no subprocess, no filesystem). Verifies the public
 * contract: scores keyed by slug, fail-open on backend failure, page-read
 * failures drop slugs silently, LRU cache hits skip the backend.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../../../config/types.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

mock.module("../../../util/platform.js", () => ({
  getWorkspaceDir: () => "/tmp/test-workspace",
}));

const backendState = {
  scores: [] as number[],
  shouldThrow: false,
  calls: [] as Array<{ query: string; passages: string[] }>,
};
mock.module("../../rerank-local.js", () => ({
  getOrCreateRerankBackend: (_model: string) => ({
    score: async (query: string, passages: string[]): Promise<number[]> => {
      backendState.calls.push({ query, passages: [...passages] });
      if (backendState.shouldThrow) throw new Error("backend down");
      return backendState.scores.slice(0, passages.length);
    },
  }),
}));

const pageState = {
  pages: new Map<string, { body: string } | null>(),
  failingSlugs: new Set<string>(),
};
// Partial mock — Bun's `mock.module` is process-wide, so we re-export every
// real symbol and override only `readPage`. Without this, sibling test files
// that import `listPages` etc. would crash with "Export not found".
const realPageStore = await import("../page-store.js");
mock.module("../page-store.js", () => ({
  ...realPageStore,
  readPage: async (_dir: string, slug: string) => {
    if (pageState.failingSlugs.has(slug)) {
      throw new Error("read failure");
    }
    return pageState.pages.get(slug) ?? null;
  },
}));

const { rerankCandidates, _resetRerankCacheForTests } =
  await import("../reranker.js");

function configWithModel(model = "test-model"): AssistantConfig {
  return {
    memory: {
      v2: {
        rerank: { model, enabled: true, top_k: 50, alpha: 0.3 },
      },
    },
  } as unknown as AssistantConfig;
}

function resetState() {
  backendState.scores = [];
  backendState.shouldThrow = false;
  backendState.calls.length = 0;
  pageState.pages.clear();
  pageState.failingSlugs.clear();
  _resetRerankCacheForTests();
}

beforeEach(resetState);
afterEach(resetState);

describe("rerankCandidates", () => {
  test("returns empty map for empty candidates", async () => {
    const out = await rerankCandidates("query", [], configWithModel());
    expect(out.size).toBe(0);
    expect(backendState.calls).toHaveLength(0);
  });

  test("returns empty map for whitespace-only query", async () => {
    pageState.pages.set("a", { body: "content" });
    const out = await rerankCandidates("   ", ["a"], configWithModel());
    expect(out.size).toBe(0);
    expect(backendState.calls).toHaveLength(0);
  });

  test("scores returned keyed by slug, in [0, 1]", async () => {
    pageState.pages.set("a", { body: "first paragraph of a" });
    pageState.pages.set("b", { body: "first paragraph of b" });
    backendState.scores = [0.9, 0.1];

    const out = await rerankCandidates("query", ["a", "b"], configWithModel());

    expect(out.get("a")).toBe(0.9);
    expect(out.get("b")).toBe(0.1);
  });

  test("clamps scores to [0, 1]", async () => {
    pageState.pages.set("a", { body: "x" });
    pageState.pages.set("b", { body: "x" });
    backendState.scores = [1.5, -0.2];

    const out = await rerankCandidates("query", ["a", "b"], configWithModel());

    expect(out.get("a")).toBe(1);
    expect(out.get("b")).toBe(0);
  });

  test("drops slugs whose page failed to read; others present", async () => {
    pageState.pages.set("a", { body: "x" });
    pageState.failingSlugs.add("b");
    pageState.pages.set("c", { body: "y" });
    backendState.scores = [0.5, 0.7];

    const out = await rerankCandidates(
      "query",
      ["a", "b", "c"],
      configWithModel(),
    );

    expect(out.has("b")).toBe(false);
    expect(out.get("a")).toBe(0.5);
    expect(out.get("c")).toBe(0.7);
  });

  test("drops slugs whose page is null (missing on disk)", async () => {
    pageState.pages.set("a", { body: "x" });
    pageState.pages.set("missing", null);
    backendState.scores = [0.5];

    const out = await rerankCandidates(
      "query",
      ["a", "missing"],
      configWithModel(),
    );

    expect(out.size).toBe(1);
    expect(out.get("a")).toBe(0.5);
    expect(out.has("missing")).toBe(false);
  });

  test("returns empty map when backend throws (fail-open)", async () => {
    pageState.pages.set("a", { body: "x" });
    backendState.shouldThrow = true;

    const out = await rerankCandidates("query", ["a"], configWithModel());

    expect(out.size).toBe(0);
  });

  test("returns empty map when no pages load (no backend call)", async () => {
    pageState.failingSlugs.add("a");

    const out = await rerankCandidates("query", ["a"], configWithModel());

    expect(out.size).toBe(0);
    expect(backendState.calls).toHaveLength(0);
  });

  test("LRU cache hit skips the backend on identical inputs", async () => {
    pageState.pages.set("a", { body: "x" });
    backendState.scores = [0.7];

    const first = await rerankCandidates("query", ["a"], configWithModel());
    const second = await rerankCandidates("query", ["a"], configWithModel());

    expect(first.get("a")).toBe(0.7);
    expect(second.get("a")).toBe(0.7);
    // Backend called only once — second call hit the cache.
    expect(backendState.calls).toHaveLength(1);
  });

  test("cache key insensitive to candidate order", async () => {
    pageState.pages.set("a", { body: "x" });
    pageState.pages.set("b", { body: "y" });
    backendState.scores = [0.5, 0.6];

    await rerankCandidates("query", ["a", "b"], configWithModel());
    await rerankCandidates("query", ["b", "a"], configWithModel());

    // Same query, same set of candidates — second call hits cache.
    expect(backendState.calls).toHaveLength(1);
  });

  test("passage construction caps at 240 chars after slug newline", async () => {
    const longBody = "a".repeat(500);
    pageState.pages.set("slug", { body: longBody });
    backendState.scores = [0.5];

    await rerankCandidates("q", ["slug"], configWithModel());

    expect(backendState.calls).toHaveLength(1);
    const passage = backendState.calls[0].passages[0];
    // "slug\n" prefix + 240 chars of body
    expect(passage.startsWith("slug\n")).toBe(true);
    expect(passage.length).toBeLessThanOrEqual(5 + 240);
  });

  test("first paragraph is taken (body truncated at blank line)", async () => {
    pageState.pages.set("slug", {
      body: "first para line\n\nsecond para should not appear",
    });
    backendState.scores = [0.5];

    await rerankCandidates("q", ["slug"], configWithModel());

    const passage = backendState.calls[0].passages[0];
    expect(passage).toContain("first para line");
    expect(passage).not.toContain("second para");
  });
});
