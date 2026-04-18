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
const qdrantDeleteCalls: Array<{ targetType: string; path: string }> = [];

mock.module("../qdrant-client.js", () => ({
  getQdrantClient: () => ({
    deleteByTargetTypeAndPath: async (targetType: string, path: string) => {
      qdrantDeleteCalls.push({ targetType, path });
    },
  }),
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
  });

  test("invokes embedAndUpsert once per chunk with pkb_file target_type", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-index-"));
    const filePath = join(root, "doc.md");
    await writeFile(filePath, "# hello\nworld");

    await indexPkbFile(root, filePath, "scope-xyz");

    expect(embedAndUpsertCalls).toHaveLength(1);
    const call = embedAndUpsertCalls[0];
    expect(call.targetType).toBe("pkb_file");
    expect(call.targetId).toBe("doc.md#0");
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
    expect(embedAndUpsertCalls[0].targetId).toBe("big.md#0");
    expect(embedAndUpsertCalls[1].targetId).toBe("big.md#1");
    expect(embedAndUpsertCalls.every((c) => c.targetType === "pkb_file")).toBe(
      true,
    );
  });
});

describe("deletePkbFilePoints", () => {
  beforeEach(() => {
    qdrantDeleteCalls.length = 0;
  });

  test("sends a filter with both target_type and path predicates", async () => {
    await deletePkbFilePoints("notes/todo.md");

    expect(qdrantDeleteCalls).toHaveLength(1);
    expect(qdrantDeleteCalls[0]).toEqual({
      targetType: "pkb_file",
      path: "notes/todo.md",
    });
  });
});
