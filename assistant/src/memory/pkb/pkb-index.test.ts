import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Capture calls to embedAndUpsert so we can assert on targetType + payload.
const embedAndUpsertCalls: Array<{
  config: unknown;
  targetType: string;
  targetId: string;
  input: unknown;
  extraPayload: unknown;
}> = [];

mock.module("../job-utils.js", () => ({
  embedAndUpsert: async (
    config: unknown,
    targetType: string,
    targetId: string,
    input: unknown,
    extraPayload: unknown,
  ) => {
    embedAndUpsertCalls.push({
      config,
      targetType,
      targetId,
      input,
      extraPayload,
    });
  },
}));

// Minimal stub for getConfig — indexPkbFile forwards it opaquely to the
// mocked embedAndUpsert, so any sentinel value works.
mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ __stub: true }),
}));

// Track Qdrant deletes by capturing the filter the client sends.
const qdrantDeleteCalls: Array<{
  targetType: string;
  path: string;
  memoryScopeId: string;
}> = [];

// Track per-target deletes (used by write-then-cleanup in indexPkbFile).
const qdrantDeleteByTargetCalls: Array<{
  targetType: string;
  targetId: string;
}> = [];

// Points the mocked scroll will return on the next call. Tests mutate this
// to simulate pre-existing PKB chunks on disk.
let scrollReturnPoints: Array<{
  id: string;
  payload: Record<string, unknown>;
}> = [];
const qdrantScrollCalls: Array<{
  targetType: string;
  memoryScopeId?: string;
  path?: string;
}> = [];

mock.module("../qdrant-client.js", () => ({
  getQdrantClient: () => ({
    deleteByTargetTypeAndPath: async (
      targetType: string,
      path: string,
      memoryScopeId: string,
    ) => {
      qdrantDeleteCalls.push({ targetType, path, memoryScopeId });
    },
    deleteByTarget: async (targetType: string, targetId: string) => {
      qdrantDeleteByTargetCalls.push({ targetType, targetId });
    },
    scrollByTargetType: async (
      targetType: string,
      options?: {
        memoryScopeId?: string;
        path?: string;
        batchSize?: number;
      },
    ) => {
      qdrantScrollCalls.push({
        targetType,
        memoryScopeId: options?.memoryScopeId,
        path: options?.path,
      });
      return scrollReturnPoints;
    },
  }),
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

// The circuit breaker is a thin wrapper; just call the function through.
mock.module("../qdrant-circuit-breaker.js", () => ({
  withQdrantBreaker: async <T,>(fn: () => Promise<T>) => fn(),
}));

import {
  chunkPkbFile,
  deletePkbFilePoints,
  indexPkbFile,
  scanPkbFiles,
} from "./pkb-index.js";

describe("chunkPkbFile", () => {
  test("returns whole-file for small inputs", () => {
    const small = "a".repeat(500);
    const chunks = chunkPkbFile(small);
    expect(chunks).toEqual([small]);
  });

  test("splits on ## headings with lossless concatenation", () => {
    const sectionA = "## Section A\n" + "a".repeat(5990) + "\n";
    const sectionB = "## Section B\n" + "b".repeat(6010);
    const content = sectionA + sectionB;
    expect(content.length).toBeGreaterThanOrEqual(12000);

    const chunks = chunkPkbFile(content);
    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(content);
    expect(chunks[0].startsWith("## Section A")).toBe(true);
    expect(chunks[1].startsWith("## Section B")).toBe(true);
  });

  test("falls back to char-window chunks when no ## headings exist", () => {
    const content = "x".repeat(12000);
    const chunks = chunkPkbFile(content);
    // 12000 / 4000 = 3 windows.
    expect(chunks).toHaveLength(3);
    expect(chunks.join("")).toBe(content);
    expect(chunks[0].length).toBe(4000);
    expect(chunks[1].length).toBe(4000);
    expect(chunks[2].length).toBe(4000);
  });
});

describe("scanPkbFiles", () => {
  test("returns entries for each .md file and ignores non-markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-scan-"));
    await writeFile(join(root, "a.md"), "# A\nalpha content");
    await writeFile(join(root, "b.md"), "# B\nbeta content");
    await writeFile(join(root, "notes.txt"), "plain text");

    // Set deterministic mtimes so we can assert them.
    const mtimeA = new Date(1_700_000_000_000);
    const mtimeB = new Date(1_700_000_001_000);
    await utimes(join(root, "a.md"), mtimeA, mtimeA);
    await utimes(join(root, "b.md"), mtimeB, mtimeB);

    const entries = await scanPkbFiles(root);
    expect(entries).not.toBeNull();
    const byPath = new Map(entries!.map((e) => [e.path, e]));

    expect(byPath.size).toBe(2);
    expect(byPath.has("a.md")).toBe(true);
    expect(byPath.has("b.md")).toBe(true);
    expect(byPath.has("notes.txt")).toBe(false);

    const a = byPath.get("a.md")!;
    expect(a.mtimeMs).toBe(mtimeA.getTime());
    expect(a.chunkIndex).toBe(0);
    expect(a.contentHash).toHaveLength(16);

    // Hash is stable across scans.
    const entriesAgain = await scanPkbFiles(root);
    const aAgain = entriesAgain!.find((e) => e.path === "a.md")!;
    expect(aAgain.contentHash).toBe(a.contentHash);
  });

  test("walks nested directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-scan-nested-"));
    const sub = join(root, "sub");
    await mkdir(sub);
    await writeFile(join(sub, "nested.md"), "# nested");

    const entries = await scanPkbFiles(root);
    expect(entries).toHaveLength(1);
    expect(entries![0].path).toBe(join("sub", "nested.md"));
  });

  test("returns null when pkbRoot does not exist", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pkb-scan-missing-"));
    const missing = join(parent, "does-not-exist");
    const entries = await scanPkbFiles(missing);
    expect(entries).toBeNull();
  });

  test("returns null when pkbRoot existed then was removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-scan-removed-"));
    await writeFile(join(root, "a.md"), "# A");
    await rm(root, { recursive: true, force: true });

    const entries = await scanPkbFiles(root);
    expect(entries).toBeNull();
  });

  test("returns [] (not null) when pkbRoot exists but is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-scan-empty-"));
    const entries = await scanPkbFiles(root);
    expect(entries).not.toBeNull();
    expect(entries).toEqual([]);
  });

  test("returns null when pkbRoot points at a file instead of a directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pkb-scan-file-"));
    const filePath = join(parent, "not-a-dir");
    await writeFile(filePath, "just a file");
    const entries = await scanPkbFiles(filePath);
    expect(entries).toBeNull();
  });
});

describe("indexPkbFile", () => {
  beforeEach(() => {
    embedAndUpsertCalls.length = 0;
    qdrantDeleteCalls.length = 0;
    qdrantDeleteByTargetCalls.length = 0;
    qdrantScrollCalls.length = 0;
    scrollReturnPoints = [];
  });

  test("invokes embedAndUpsert once per chunk with pkb_file target_type", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-index-"));
    const filePath = join(root, "doc.md");
    await writeFile(filePath, "# hello\nworld");

    await indexPkbFile(root, filePath, "scope-xyz");

    expect(embedAndUpsertCalls).toHaveLength(1);
    const call = embedAndUpsertCalls[0];
    expect(call.targetType).toBe("pkb_file");
    expect(call.targetId).toBe("scope-xyz:doc.md#0");
    expect(call.input).toEqual({ type: "text", text: "# hello\nworld" });
    const payload = call.extraPayload as Record<string, unknown>;
    expect(payload.path).toBe("doc.md");
    expect(payload.chunk_index).toBe(0);
    expect(payload.memory_scope_id).toBe("scope-xyz");
    expect(typeof payload.mtime_ms).toBe("number");
    expect(typeof payload.content_hash).toBe("string");
    expect((payload.content_hash as string).length).toBe(16);
  });

  test("emits one embedAndUpsert call per chunk for a large file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-index-large-"));
    const filePath = join(root, "big.md");
    const content =
      "## Section A\n" +
      "a".repeat(5990) +
      "\n## Section B\n" +
      "b".repeat(5990);
    await writeFile(filePath, content);

    await indexPkbFile(root, filePath, "scope-1");

    expect(embedAndUpsertCalls).toHaveLength(2);
    expect(embedAndUpsertCalls[0].targetId).toBe("scope-1:big.md#0");
    expect(embedAndUpsertCalls[1].targetId).toBe("scope-1:big.md#1");
    expect(embedAndUpsertCalls.every((c) => c.targetType === "pkb_file")).toBe(
      true,
    );
  });

  test("scope-namespaces target ids so two scopes indexing the same path do not collide", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-index-scope-"));
    const filePath = join(root, "shared.md");
    await writeFile(filePath, "# shared");

    await indexPkbFile(root, filePath, "alpha");
    await indexPkbFile(root, filePath, "beta");

    expect(embedAndUpsertCalls).toHaveLength(2);
    const ids = embedAndUpsertCalls.map((c) => c.targetId);
    expect(ids).toEqual(["alpha:shared.md#0", "beta:shared.md#0"]);
  });

  test("scrolls existing chunks scoped to (target_type, scope, path) before upserting", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-index-scroll-"));
    const filePath = join(root, "noted.md");
    await writeFile(filePath, "# one");

    await indexPkbFile(root, filePath, "scope-xyz");

    expect(qdrantScrollCalls).toHaveLength(1);
    expect(qdrantScrollCalls[0]).toEqual({
      targetType: "pkb_file",
      memoryScopeId: "scope-xyz",
      path: "noted.md",
    });
  });

  test("deletes only stale chunks after upserting (write-then-cleanup)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-index-shrink-"));
    const filePath = join(root, "shrinking.md");
    // New content produces a single chunk (index #0). Pre-existing chunks
    // #0..#2 simulate a prior run over a larger file.
    await writeFile(filePath, "# just one");
    scrollReturnPoints = [
      {
        id: "point-0",
        payload: { target_id: "scope-xyz:shrinking.md#0" },
      },
      {
        id: "point-1",
        payload: { target_id: "scope-xyz:shrinking.md#1" },
      },
      {
        id: "point-2",
        payload: { target_id: "scope-xyz:shrinking.md#2" },
      },
    ];

    await indexPkbFile(root, filePath, "scope-xyz");

    // Exactly one upsert for the surviving chunk.
    expect(embedAndUpsertCalls).toHaveLength(1);
    expect(embedAndUpsertCalls[0].targetId).toBe("scope-xyz:shrinking.md#0");

    // The pre-delete is gone; only the two stale chunks are removed.
    expect(qdrantDeleteCalls).toHaveLength(0);
    const staleTargetIds = qdrantDeleteByTargetCalls.map((c) => c.targetId);
    expect(staleTargetIds.sort()).toEqual([
      "scope-xyz:shrinking.md#1",
      "scope-xyz:shrinking.md#2",
    ]);
  });

  test("does not delete points whose target_id is regenerated", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-index-stable-"));
    const filePath = join(root, "stable.md");
    await writeFile(filePath, "# same");
    scrollReturnPoints = [
      {
        id: "point-0",
        payload: { target_id: "scope-xyz:stable.md#0" },
      },
    ];

    await indexPkbFile(root, filePath, "scope-xyz");

    expect(embedAndUpsertCalls).toHaveLength(1);
    expect(qdrantDeleteByTargetCalls).toHaveLength(0);
  });
});

describe("deletePkbFilePoints", () => {
  beforeEach(() => {
    qdrantDeleteCalls.length = 0;
  });

  test("sends a filter with target_type, path, and memory_scope_id predicates", async () => {
    await deletePkbFilePoints("notes/todo.md", "scope-xyz");

    expect(qdrantDeleteCalls).toHaveLength(1);
    expect(qdrantDeleteCalls[0]).toEqual({
      targetType: "pkb_file",
      path: "notes/todo.md",
      memoryScopeId: "scope-xyz",
    });
  });
});
