import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Capture enqueued PKB re-index jobs.
const enqueuedJobs: Array<{
  pkbRoot: string;
  absPath: string;
  memoryScopeId: string;
}> = [];

mock.module("../jobs/embed-pkb-file.js", () => ({
  enqueuePkbIndexJob: (input: {
    pkbRoot: string;
    absPath: string;
    memoryScopeId: string;
  }) => {
    enqueuedJobs.push(input);
    return "job-id";
  },
}));

// Capture calls into the fake Qdrant client.
let scrollPoints: Array<{ id: string; payload: Record<string, unknown> }> = [];
const deleteCalls: string[] = [];

mock.module("../qdrant-client.js", () => ({
  getQdrantClient: () => ({
    scrollByTargetType: async (
      _targetType: string,
      _options?: { memoryScopeId?: string },
    ) => scrollPoints,
    deleteByTargetTypeAndPath: async (_targetType: string, path: string) => {
      deleteCalls.push(path);
    },
  }),
}));

// Circuit breaker — pass-through.
mock.module("../qdrant-circuit-breaker.js", () => ({
  withQdrantBreaker: async <T,>(fn: () => Promise<T>) => fn(),
}));

// indexPkbFile is not invoked from the reconcile path (we enqueue jobs
// instead), but the pkb-index module imports the embedding pipeline which
// pulls in a config. Stub it so module import doesn't explode.
mock.module("../job-utils.js", () => ({
  embedAndUpsert: async () => {},
}));
mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ __stub: true }),
}));

import { reconcilePkbIndex } from "./pkb-reconcile.js";

function pkbPoint(
  path: string,
  contentHash: string,
  chunkIndex = 0,
): { id: string; payload: Record<string, unknown> } {
  return {
    id: `${path}#${chunkIndex}`,
    payload: {
      target_type: "pkb_file",
      target_id: `${path}#${chunkIndex}`,
      path,
      chunk_index: chunkIndex,
      content_hash: contentHash,
      memory_scope_id: "default",
    },
  };
}

// sha256(content).slice(0, 16) — precomputing isn't necessary; reconcile only
// compares hashes for equality, so we read the real hash after scanning.
import { scanPkbFiles } from "./pkb-index.js";

async function seedPkbAndHash(
  root: string,
  files: Array<{ path: string; content: string }>,
): Promise<Map<string, string>> {
  for (const f of files) {
    await writeFile(join(root, f.path), f.content);
  }
  const entries = await scanPkbFiles(root);
  const byPath = new Map<string, string>();
  for (const e of entries) byPath.set(e.path, e.contentHash);
  return byPath;
}

describe("reconcilePkbIndex", () => {
  beforeEach(() => {
    enqueuedJobs.length = 0;
    deleteCalls.length = 0;
    scrollPoints = [];
  });

  test("fresh install: enqueues every on-disk file, deletes nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-reconcile-fresh-"));
    await seedPkbAndHash(root, [
      { path: "a.md", content: "# A" },
      { path: "b.md", content: "# B" },
    ]);

    // Qdrant empty.
    scrollPoints = [];

    const result = await reconcilePkbIndex(root, "default");

    expect(result.enqueued).toBe(2);
    expect(result.deleted).toBe(0);
    expect(enqueuedJobs).toHaveLength(2);
    const paths = new Set(enqueuedJobs.map((j) => j.absPath));
    expect(paths.has(join(root, "a.md"))).toBe(true);
    expect(paths.has(join(root, "b.md"))).toBe(true);
    for (const job of enqueuedJobs) {
      expect(job.pkbRoot).toBe(root);
      expect(job.memoryScopeId).toBe("default");
    }
    expect(deleteCalls).toHaveLength(0);
  });

  test("steady state: matching hashes → no work enqueued or deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-reconcile-steady-"));
    const hashes = await seedPkbAndHash(root, [
      { path: "a.md", content: "# A" },
      { path: "b.md", content: "# B" },
    ]);

    scrollPoints = [
      pkbPoint("a.md", hashes.get("a.md")!),
      pkbPoint("b.md", hashes.get("b.md")!),
    ];

    const result = await reconcilePkbIndex(root, "default");

    expect(result.enqueued).toBe(0);
    expect(result.deleted).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });

  test("modified file: hash drift enqueues exactly one re-index", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-reconcile-modified-"));
    const hashes = await seedPkbAndHash(root, [
      { path: "a.md", content: "# A updated" },
      { path: "b.md", content: "# B" },
    ]);

    // Qdrant has a stale hash for a.md but matches for b.md.
    scrollPoints = [
      pkbPoint("a.md", "0000000000000000"),
      pkbPoint("b.md", hashes.get("b.md")!),
    ];

    const result = await reconcilePkbIndex(root, "default");

    expect(result.enqueued).toBe(1);
    expect(result.deleted).toBe(0);
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0].absPath).toBe(join(root, "a.md"));
    expect(deleteCalls).toHaveLength(0);
  });

  test("stale indexed path not on disk: deletes that path, enqueues nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-reconcile-stale-"));
    const hashes = await seedPkbAndHash(root, [
      { path: "a.md", content: "# A" },
    ]);

    // Qdrant has a.md (matching) plus a phantom gone.md.
    scrollPoints = [
      pkbPoint("a.md", hashes.get("a.md")!),
      pkbPoint("gone.md", "dead00dead00dead"),
    ];

    const result = await reconcilePkbIndex(root, "default");

    expect(result.enqueued).toBe(0);
    expect(result.deleted).toBe(1);
    expect(deleteCalls).toEqual(["gone.md"]);
    expect(enqueuedJobs).toHaveLength(0);
  });

  test("collapses multiple chunk points for the same path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pkb-reconcile-chunks-"));
    const hashes = await seedPkbAndHash(root, [
      { path: "a.md", content: "# A" },
    ]);

    // Two chunk points for a.md with identical hashes.
    scrollPoints = [
      pkbPoint("a.md", hashes.get("a.md")!, 0),
      pkbPoint("a.md", hashes.get("a.md")!, 1),
    ];

    const result = await reconcilePkbIndex(root, "default");

    expect(result.enqueued).toBe(0);
    expect(result.deleted).toBe(0);
  });
});
