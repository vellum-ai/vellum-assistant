/**
 * Tests for `assistant/src/memory/embedding-cache.ts` — the shared dense-vector
 * cache over the `memory_embeddings` table. Exercises the real SQL against a
 * temp workspace DB (round-trip, dim-mismatch miss, key isolation, upsert).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "embedding-cache-test-"));
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

// Deferred so internal `getWorkspaceDir()` resolves to the tmpdir set above.
const { getDb } = await import("../../../../persistence/db-connection.js");
const { resetDbForTesting } =
  await import("../../../../__tests__/db-test-helpers.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { memoryEmbeddings } =
  await import("../../../../persistence/schema/index.js");
const { readEmbeddingCache, writeEmbeddingCache } =
  await import("../../../../persistence/embeddings/embedding-cache.js");

beforeEach(async () => {
  resetDbForTesting();
  // The first run pays the full cold-start migration chain; bump the hook
  // timeout above bun's 5s default so the leading test doesn't flake in CI.
  await initializeDb();
}, 30_000);

const KEY = {
  targetType: "v3_section",
  targetId: "people/alice#0",
  provider: "local",
  model: "test-model",
  expectedDim: 4,
} as const;

function seed(
  overrides: Partial<{
    dense: number[];
    contentHash: string;
    now: number;
  }> = {},
): void {
  writeEmbeddingCache(getDb(), {
    targetType: KEY.targetType,
    targetId: KEY.targetId,
    provider: KEY.provider,
    model: KEY.model,
    dense: overrides.dense ?? [1, 2, 3, 4],
    contentHash: overrides.contentHash ?? "hash-a",
    now: overrides.now ?? 1000,
  });
}

describe("embedding-cache", () => {
  test("read returns null when nothing is cached", () => {
    expect(readEmbeddingCache(getDb(), KEY)).toBeNull();
  });

  test("write then read round-trips the vector and content hash", () => {
    seed({ dense: [1, 2, 3, 4], contentHash: "hash-a" });

    const got = readEmbeddingCache(getDb(), KEY);
    expect(got).not.toBeNull();
    expect(got!.dense).toEqual([1, 2, 3, 4]);
    expect(got!.contentHash).toBe("hash-a");
  });

  test("read misses when the configured dimension differs from the stored row", () => {
    seed();
    expect(readEmbeddingCache(getDb(), { ...KEY, expectedDim: 8 })).toBeNull();
  });

  test("read is isolated by targetType / targetId / provider / model", () => {
    seed();
    const db = getDb();
    expect(
      readEmbeddingCache(db, { ...KEY, targetType: "concept_page" }),
    ).toBeNull();
    expect(
      readEmbeddingCache(db, { ...KEY, targetId: "people/bob#0" }),
    ).toBeNull();
    expect(readEmbeddingCache(db, { ...KEY, provider: "openai" })).toBeNull();
    expect(readEmbeddingCache(db, { ...KEY, model: "other-model" })).toBeNull();
  });

  test("re-writing the same key upserts in place (one row, latest content)", () => {
    const db = getDb();
    seed({ dense: [1, 2, 3, 4], contentHash: "hash-a", now: 1000 });
    seed({ dense: [5, 6, 7, 8], contentHash: "hash-b", now: 2000 });

    const got = readEmbeddingCache(db, KEY);
    expect(got!.dense).toEqual([5, 6, 7, 8]);
    expect(got!.contentHash).toBe("hash-b");

    // The unique key collapses both writes onto a single row.
    const rows = db
      .select()
      .from(memoryEmbeddings)
      .all()
      .filter(
        (r) => r.targetType === KEY.targetType && r.targetId === KEY.targetId,
      );
    expect(rows).toHaveLength(1);
  });
});
