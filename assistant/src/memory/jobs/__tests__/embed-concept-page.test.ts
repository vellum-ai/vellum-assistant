/**
 * Tests for `assistant/src/memory/jobs/embed-concept-page.ts`.
 *
 * Coverage matrix (from PR 13 acceptance criteria):
 *   - Enqueue + dispatch round-trip: writing a page → enqueueing the job →
 *     dispatching it via `embedConceptPageJob` → upserts the embedding.
 *   - Delete propagation: when the page is missing on disk, the handler
 *     removes the embedding instead of upserting.
 *   - Cache hit: a second run with the same content reuses the cached dense
 *     vector and skips the embedding backend.
 *   - Skips when slug is missing from the payload (defensive).
 *
 * Mocks: the embedding backend, Qdrant client, and v2 qdrant module are
 * stubbed so the test runs without network/IO. Pages live on a temp
 * workspace under `os.tmpdir()` per the cross-cutting safety rule.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Embedding backend stub ─────────────────────────────────────────
// `embedConceptPageJob` calls `getMemoryBackendStatus` first to verify a
// provider is configured, then `embedWithBackend` for the dense vector and
// `generateSparseEmbedding` for the sparse one. Stub all three so tests run
// without an embedding backend.

const embedWithBackendCalls: Array<{
  inputs: unknown;
  options: unknown;
}> = [];

mock.module("../../embedding-backend.js", () => ({
  getMemoryBackendStatus: async () => ({
    enabled: true,
    degraded: false,
    provider: "local",
    model: "test-model",
    reason: null,
  }),
  embedWithBackend: async (
    _config: unknown,
    inputs: unknown[],
    options?: unknown,
  ) => {
    embedWithBackendCalls.push({ inputs, options });
    // Return a dense vector matching the test config's vectorSize (4).
    return {
      provider: "local" as const,
      model: "test-model",
      vectors: inputs.map(() => [0.1, 0.2, 0.3, 0.4]),
    };
  },
  generateSparseEmbedding: (text: string) => ({
    indices: [text.length % 100],
    values: [1],
  }),
  // Other exports from the real module — stubbed so adjacent imports
  // (e.g. via transitive `db.ts` → `indexer.ts`) don't crash on missing
  // names when the mock replaces the module wholesale.
  selectedBackendSupportsMultimodal: async () => false,
}));

// ── v2 qdrant stub ─────────────────────────────────────────────────
// `embedConceptPageJob` upserts via `upsertConceptPageEmbedding` and deletes
// via `deleteConceptPageEmbedding`. Capture both so we can assert on them.

const upsertCalls: Array<{
  slug: string;
  dense: number[];
  sparse: { indices: number[]; values: number[] };
  updatedAt: number;
}> = [];

const deleteCalls: string[] = [];

mock.module("../../v2/qdrant.js", () => ({
  upsertConceptPageEmbedding: async (params: {
    slug: string;
    dense: number[];
    sparse: { indices: number[]; values: number[] };
    updatedAt: number;
  }) => {
    upsertCalls.push(params);
  },
  deleteConceptPageEmbedding: async (slug: string) => {
    deleteCalls.push(slug);
  },
  // Other exports from the real module — stubbed so transitive imports
  // don't crash on missing names when the mock replaces the module wholesale.
  hybridQueryConceptPages: async () => [],
}));

// ── Workspace setup ────────────────────────────────────────────────
let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "embed-concept-page-test-"));
  mkdirSync(join(tmpWorkspace, "memory", "concepts"), { recursive: true });
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

// Imports are deferred to after the env var is set so any internal use of
// `getWorkspaceDir()` resolves to the tmpdir.
const { DEFAULT_CONFIG } = await import("../../../config/defaults.js");
const { getDb, resetDb } = await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { memoryEmbeddings, memoryJobs } = await import("../../schema.js");
const { claimMemoryJobs } = await import("../../jobs-store.js");
type MemoryJobMod = typeof import("../../jobs-store.js");
type MemoryJob = ReturnType<MemoryJobMod["claimMemoryJobs"]>[number];
const { embedConceptPageJob, enqueueEmbedConceptPageJob } =
  await import("../embed-concept-page.js");
const { writePage } = await import("../../v2/page-store.js");

// Use a tiny vectorSize so the cache-dim check matches our stub vector.
const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    qdrant: {
      ...DEFAULT_CONFIG.memory.qdrant,
      vectorSize: 4,
    },
  },
};

function makeJob(payload: Record<string, unknown>): MemoryJob {
  return {
    id: "job-1",
    type: "embed_concept_page",
    payload,
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

beforeEach(() => {
  resetDb();
  initializeDb();
  embedWithBackendCalls.length = 0;
  upsertCalls.length = 0;
  deleteCalls.length = 0;
});

afterEach(() => {
  // Clean up any pages written between tests so each scenario starts fresh.
  rmSync(join(tmpWorkspace, "memory", "concepts"), {
    recursive: true,
    force: true,
  });
  mkdirSync(join(tmpWorkspace, "memory", "concepts"), { recursive: true });
});

// ---------------------------------------------------------------------------

describe("embedConceptPageJob — happy path", () => {
  test("reads the page, embeds it, and upserts to the v2 collection", async () => {
    await writePage(tmpWorkspace, {
      slug: "alice-prefers-vs-code",
      frontmatter: { edges: [], ref_files: [] },
      body: "Alice prefers VS Code over Vim.\nShe ships at end of day.\n",
    });

    await embedConceptPageJob(
      makeJob({ slug: "alice-prefers-vs-code" }),
      TEST_CONFIG,
    );

    // Dense embedding came from the backend stub once (no cache to start).
    expect(embedWithBackendCalls).toHaveLength(1);

    // Exactly one upsert with both vectors and the slug payload.
    expect(upsertCalls).toHaveLength(1);
    const call = upsertCalls[0];
    expect(call.slug).toBe("alice-prefers-vs-code");
    expect(call.dense).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(call.sparse.indices.length).toBe(1);
    expect(call.sparse.values).toEqual([1]);
    expect(typeof call.updatedAt).toBe("number");

    // Delete path was never taken.
    expect(deleteCalls).toEqual([]);
  });

  test("populates the SQLite embedding cache row keyed on (concept_page, slug)", async () => {
    await writePage(tmpWorkspace, {
      slug: "bob-uses-zsh",
      frontmatter: { edges: [], ref_files: [] },
      body: "Bob uses zsh.\n",
    });

    await embedConceptPageJob(makeJob({ slug: "bob-uses-zsh" }), TEST_CONFIG);

    const row = getDb()
      .select()
      .from(memoryEmbeddings)
      .all()
      .find((r) => r.targetId === "bob-uses-zsh");

    expect(row).toBeDefined();
    expect(row!.targetType).toBe("concept_page");
    expect(row!.dimensions).toBe(4);
    expect(row!.contentHash).toBeTruthy();
  });
});

describe("embedConceptPageJob — cache hit", () => {
  test("reuses the cached dense vector when content hash matches", async () => {
    await writePage(tmpWorkspace, {
      slug: "alice-prefers-vs-code",
      frontmatter: { edges: [], ref_files: [] },
      body: "Stable content.\n",
    });

    // First run — primes the cache.
    await embedConceptPageJob(
      makeJob({ slug: "alice-prefers-vs-code" }),
      TEST_CONFIG,
    );
    expect(embedWithBackendCalls).toHaveLength(1);

    // Second run with identical body — backend should not be hit again.
    await embedConceptPageJob(
      makeJob({ slug: "alice-prefers-vs-code" }),
      TEST_CONFIG,
    );
    expect(embedWithBackendCalls).toHaveLength(1);

    // Both runs upserted to Qdrant — caching only saves the embedding step.
    expect(upsertCalls).toHaveLength(2);
  });

  test("re-embeds when the body changes (content hash mismatch)", async () => {
    await writePage(tmpWorkspace, {
      slug: "alice-prefers-vs-code",
      frontmatter: { edges: [], ref_files: [] },
      body: "First content.\n",
    });
    await embedConceptPageJob(
      makeJob({ slug: "alice-prefers-vs-code" }),
      TEST_CONFIG,
    );

    // Rewrite with different body.
    await writePage(tmpWorkspace, {
      slug: "alice-prefers-vs-code",
      frontmatter: { edges: [], ref_files: [] },
      body: "Second content (different).\n",
    });
    await embedConceptPageJob(
      makeJob({ slug: "alice-prefers-vs-code" }),
      TEST_CONFIG,
    );

    // Both runs hit the backend because the second body produces a new hash.
    expect(embedWithBackendCalls).toHaveLength(2);
    expect(upsertCalls).toHaveLength(2);
  });
});

describe("embedConceptPageJob — delete propagation", () => {
  test("removes the embedding when the page is missing on disk", async () => {
    // No `writePage` → page does not exist. Worker should clean up Qdrant.
    await embedConceptPageJob(makeJob({ slug: "deleted-slug" }), TEST_CONFIG);

    expect(deleteCalls).toEqual(["deleted-slug"]);
    expect(upsertCalls).toEqual([]);
    expect(embedWithBackendCalls).toEqual([]);
  });
});

describe("embedConceptPageJob — defensive", () => {
  test("skips when slug is missing from the payload", async () => {
    await embedConceptPageJob(makeJob({}), TEST_CONFIG);
    expect(upsertCalls).toEqual([]);
    expect(deleteCalls).toEqual([]);
    expect(embedWithBackendCalls).toEqual([]);
  });

  test("skips when slug is the empty string", async () => {
    await embedConceptPageJob(makeJob({ slug: "" }), TEST_CONFIG);
    expect(upsertCalls).toEqual([]);
    expect(deleteCalls).toEqual([]);
  });
});

describe("enqueueEmbedConceptPageJob", () => {
  test("enqueues a pending embed_concept_page job with the slug payload", () => {
    const id = enqueueEmbedConceptPageJob({ slug: "alice-prefers-vs-code" });
    expect(id).toBeTruthy();

    const claimed = claimMemoryJobs(10);
    expect(claimed).toHaveLength(1);
    const [job] = claimed;
    expect(job.type).toBe("embed_concept_page");
    expect(job.payload).toEqual({ slug: "alice-prefers-vs-code" });
  });

  test("round-trip: enqueued job dispatches through embedConceptPageJob", async () => {
    await writePage(tmpWorkspace, {
      slug: "round-trip-slug",
      frontmatter: { edges: [], ref_files: [] },
      body: "Round-trip body.\n",
    });

    enqueueEmbedConceptPageJob({ slug: "round-trip-slug" });

    const claimed = claimMemoryJobs(10);
    expect(claimed).toHaveLength(1);
    const [job] = claimed;
    expect(job.type).toBe("embed_concept_page");

    await embedConceptPageJob(job, TEST_CONFIG);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].slug).toBe("round-trip-slug");
  });

  test("inserted job row carries the right type and slug payload", () => {
    const id = enqueueEmbedConceptPageJob({ slug: "row-check" });

    const row = getDb()
      .select()
      .from(memoryJobs)
      .all()
      .find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.type).toBe("embed_concept_page");
    expect(JSON.parse(row!.payload)).toEqual({ slug: "row-check" });
  });
});
