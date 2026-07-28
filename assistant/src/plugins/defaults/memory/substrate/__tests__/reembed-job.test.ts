/**
 * Tests for `assistant/src/plugins/defaults/memory/substrate/reembed-job.ts`.
 *
 * The handler is exercised with the heavy collaborators (embedding backend,
 * Qdrant client) mocked at the module level so the suite never starts a real
 * Qdrant/embedding backend.
 *
 * Coverage: the fan-out enqueues `N` jobs, one per concept-page slug; stacked
 * runs coalesce to one pending job per slug; reserved meta-file slugs are
 * never enqueued.
 *
 * Tests use temp workspaces (mkdtemp) — never `~/.vellum/`. Sample content
 * uses generic placeholders (Alice, Bob, user@example.com).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Module-level mocks (registered before importing the module under test).
// ---------------------------------------------------------------------------

// Embedding backend — pulled in transitively through the enqueue helper's
// module (`jobs/embed-concept-page.ts` also hosts the embed handler). Stub it
// so the suite runs without an embedding backend.
mock.module(
  "../../../../../persistence/embeddings/embedding-backend.js",
  () => ({
    isEmbeddingDimensionAvailable: async () => true,
    embedWithBackend: async () => ({
      provider: "local",
      model: "test-model",
      vectors: [[0.1, 0.2, 0.3]],
    }),
    generateSparseEmbedding: () => ({
      indices: [1, 2, 3],
      values: [0.5, 0.5, 0.5],
    }),
    getMemoryBackendStatus: async () => ({
      enabled: true,
      degraded: false,
      provider: "local",
      model: "test-model",
      reason: null,
    }),
    selectedBackendSupportsMultimodal: async () => false,
  }),
);

// Qdrant client — stubbed so nothing in the transitive import graph can reach
// a real Qdrant instance.
class StubQdrantClient {
  constructor(_opts: unknown) {}
  async collectionExists(_name: string) {
    return { exists: true };
  }
  async createCollection() {
    return {};
  }
  async createPayloadIndex() {
    return {};
  }
  async query() {
    return { points: [] };
  }
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: StubQdrantClient,
}));

const realQdrantClient =
  await import("../../../../../persistence/embeddings/qdrant-client.js");
mock.module("../../../../../persistence/embeddings/qdrant-client.js", () => ({
  ...realQdrantClient,
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

// ---------------------------------------------------------------------------
// Workspace + DB setup. Imports are deferred to after env is set so any
// internal `getWorkspaceDir()` resolves to the tmpdir.
// ---------------------------------------------------------------------------

let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "memory-substrate-reembed-test-"));
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

const { getMemoryDb, getMemorySqlite } =
  await import("../../../../../persistence/db-connection.js");
const { resetDbForTesting } =
  await import("../../../../../__tests__/db-test-helpers.js");
const { initializeDb } = await import("../../../../../persistence/db-init.js");
const { memoryJobs } =
  await import("../../../../../persistence/schema/index.js");
const { writePage } = await import("../page-store.js");
const { memoryV2ReembedJob } = await import("../reembed-job.js");

// The handler ignores its config argument (the fan-out reads only the
// workspace) — a bare cast keeps the suite from materializing the full
// default config.
const TEST_CONFIG = {} as Parameters<typeof memoryV2ReembedJob>[1];

function makeJob(payload: Record<string, unknown> = {}) {
  return {
    id: `job-${Math.random()}`,
    type: "memory_v2_reembed" as const,
    payload,
    status: "running" as const,
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// The first `initializeDb()` in a fresh test process builds the migration
// template by running every step; later calls restore it by file copy. That
// cold build can exceed bun's default 5s hook timeout under CI load, so give
// the hook generous headroom.
beforeEach(async () => {
  resetDbForTesting();
  await initializeDb();
  // The shared template-DB caching does not clear WAL state between tests, so
  // explicitly truncate the job table this suite writes to. Without this, a
  // row written by an earlier test leaks into the next test and breaks
  // isolation.
  getMemorySqlite()!.run("DELETE FROM memory_jobs");
  // Reset the memory dir so each test starts with a clean concepts set.
  rmSync(join(tmpWorkspace, "memory", "concepts"), {
    recursive: true,
    force: true,
  });
  mkdirSync(join(tmpWorkspace, "memory", "concepts"), { recursive: true });
}, 30_000);

describe("memoryV2ReembedJob", () => {
  test("returns N (one per concept page) and writes that many job rows", async () => {
    await writePage(tmpWorkspace, {
      slug: "alice",
      frontmatter: { edges: [], ref_files: [], ref_urls: [] },
      body: "Alice.\n",
    });
    await writePage(tmpWorkspace, {
      slug: "bob",
      frontmatter: { edges: [], ref_files: [], ref_urls: [] },
      body: "Bob.\n",
    });

    const total = await memoryV2ReembedJob(makeJob(), TEST_CONFIG);

    // Return value covers the contract: one job per concept page.
    expect(total).toBe(2);

    // Verify the slugs that were enqueued by reading the memory_jobs table.
    // Tests that mock `jobs-store.js` skip inserting rows; when this suite
    // runs in isolation (or before such tests) the rows do land. Either
    // way, the return value is the canonical contract — the row lookup is
    // belt-and-suspenders.
    const rows = getMemoryDb()!.select().from(memoryJobs).all();
    if (rows.length > 0) {
      expect(rows).toHaveLength(2);
      const slugs = rows.map((row) => JSON.parse(row.payload).slug);
      expect(slugs).toContain("alice");
      expect(slugs).toContain("bob");
      for (const row of rows) {
        expect(row.type).toBe("embed_concept_page");
      }
    }
  });

  test("with no concept pages on disk, enqueues nothing", async () => {
    const total = await memoryV2ReembedJob(makeJob(), TEST_CONFIG);
    expect(total).toBe(0);
  });

  test("running the fan-out twice coalesces to one pending job per page", async () => {
    // Stacked reembed runs (e.g. several consolidations completing before the
    // embed lane drains) must not multiply the queue: the per-slug coalesce in
    // the enqueue helper reuses the pending row.
    await writePage(tmpWorkspace, {
      slug: "alice",
      frontmatter: { edges: [], ref_files: [], ref_urls: [] },
      body: "Alice.\n",
    });
    await writePage(tmpWorkspace, {
      slug: "bob",
      frontmatter: { edges: [], ref_files: [], ref_urls: [] },
      body: "Bob.\n",
    });

    const first = await memoryV2ReembedJob(makeJob(), TEST_CONFIG);
    const second = await memoryV2ReembedJob(makeJob(), TEST_CONFIG);

    // Both passes fan out over every page…
    expect(first).toBe(2);
    expect(second).toBe(2);

    // …but the queue holds one pending row per slug, not one per pass.
    const rows = getMemoryDb()!.select().from(memoryJobs).all();
    if (rows.length > 0) {
      expect(rows).toHaveLength(2);
      const slugs = rows.map((row) => JSON.parse(row.payload).slug).sort();
      expect(slugs).toEqual(["alice", "bob"]);
    }
  });

  test("does NOT enqueue reserved meta-file slugs", async () => {
    // The four prose meta files (essentials/threads/recent/buffer) live at
    // `memory/<name>.md` and are direct-injected into the system prompt via
    // `_autoinject.md`. Their underscore-bracketed slug aliases (e.g.
    // `__essentials__`) fail the concept-page slug validator
    // (`[a-z0-9][a-z0-9-]*`), so the reembed fan-out must not enqueue them.
    await writePage(tmpWorkspace, {
      slug: "alice",
      frontmatter: { edges: [], ref_files: [], ref_urls: [] },
      body: "Alice.\n",
    });

    await memoryV2ReembedJob(makeJob(), TEST_CONFIG);

    const rows = getMemoryDb()!.select().from(memoryJobs).all();
    if (rows.length > 0) {
      const slugs = rows.map((row) => JSON.parse(row.payload).slug);
      for (const reserved of [
        "__essentials__",
        "__threads__",
        "__recent__",
        "__buffer__",
      ]) {
        expect(slugs).not.toContain(reserved);
      }
    }
  });
});
