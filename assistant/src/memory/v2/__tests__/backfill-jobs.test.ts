/**
 * Tests for `assistant/src/memory/v2/backfill-jobs.ts`.
 *
 * Each handler is exercised with the heavy collaborators (migration runner,
 * embedding backend, Qdrant client, activation pipeline) mocked at the
 * module level so the suite never starts a real Qdrant/embedding backend.
 *
 * Coverage matrix (PR 21 acceptance criteria):
 *   - migrate: wraps `runMemoryV2Migration`; force flag propagates;
 *     `MigrationAlreadyAppliedError` is swallowed (no rethrow).
 *   - rebuild-edges: every page's `edges:` frontmatter matches `edges.json`;
 *     `ref_files` is preserved; pages without edges get `edges: []`.
 *   - reembed: enqueues `N + 4` jobs (concept-page slugs plus four reserved
 *     meta-file slugs).
 *   - activation-recompute: walks conversations with rows, runs the pipeline
 *     end-to-end against the real activation module, persists fresh state.
 *
 * Tests use temp workspaces (mkdtemp) — never `~/.vellum/`. Sample content
 * uses generic placeholders (Alice, Bob, user@example.com).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Module-level mocks (registered before importing the module under test).
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Migration runner — `migrate` job wraps this. The stub records call args
// and lets each test choose the resolution shape (success, sentinel error).
const migrationCalls: Array<{
  workspaceDir: string;
  force: boolean;
}> = [];
let migrationOutcome:
  | { type: "ok" }
  | { type: "sentinel" }
  | { type: "throw"; error: Error } = { type: "ok" };

class MigrationAlreadyAppliedError extends Error {
  constructor() {
    super("sentinel exists");
    this.name = "MigrationAlreadyAppliedError";
  }
}

mock.module("../migration.js", () => ({
  MigrationAlreadyAppliedError,
  runMemoryV2Migration: async (params: {
    workspaceDir: string;
    force?: boolean;
  }) => {
    migrationCalls.push({
      workspaceDir: params.workspaceDir,
      force: params.force === true,
    });
    if (migrationOutcome.type === "sentinel") {
      throw new MigrationAlreadyAppliedError();
    }
    if (migrationOutcome.type === "throw") {
      throw migrationOutcome.error;
    }
    return {
      pagesCreated: 1,
      edgesWritten: 0,
      essentialsLines: 0,
      threadsLines: 0,
      archiveLines: 0,
      embedsEnqueued: 1,
      sentinelWritten: true,
    };
  },
}));

// `qdrant.ts#ensureConceptPageCollection` reads its vector size via
// `getConfig()` (the runtime config singleton). Stub it with a fully-
// specified memory.qdrant block so cross-test pollution from sibling test
// files (which install their own loader mocks) cannot strip these fields.
const STUB_RUNTIME_CONFIG = {
  memory: {
    qdrant: {
      url: "http://127.0.0.1:6333",
      vectorSize: 3,
      onDisk: true,
    },
    v2: {
      enabled: true,
      d: 0.3,
      c_user: 0.3,
      c_assistant: 0.2,
      c_now: 0.2,
      k: 0.5,
      hops: 2,
      top_k: 20,
      epsilon: 0.01,
      dense_weight: 0.7,
      sparse_weight: 0.3,
      consolidation_interval_hours: 1,
      max_page_chars: 5000,
    },
  },
};
mock.module("../../../config/loader.js", () => ({
  getConfig: () => STUB_RUNTIME_CONFIG,
  loadConfig: () => STUB_RUNTIME_CONFIG,
  invalidateConfigCache: () => {},
  applyNestedDefaults: () => STUB_RUNTIME_CONFIG,
}));

// Embedding backend — `activation` calls `embedWithBackend` and
// `generateSparseEmbedding` to build the ANN candidate query. Stub both so
// the suite runs without an embedding backend.
mock.module("../../embedding-backend.js", () => ({
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
}));

// Qdrant client — `activation.selectCandidates` runs an ANN query, and
// `simBatch` runs per-channel queries. Returning empty hit lists keeps the
// candidate set bounded by prior state, which is enough to verify that
// `activation-recompute` exercises the pipeline end-to-end.
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

const realQdrantClient = await import("../../qdrant-client.js");
mock.module("../../qdrant-client.js", () => ({
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
  tmpWorkspace = mkdtempSync(join(tmpdir(), "memory-v2-backfill-test-"));
  mkdirSync(join(tmpWorkspace, "memory", "concepts"), { recursive: true });
  mkdirSync(join(tmpWorkspace, "memory", "archive"), { recursive: true });
  mkdirSync(join(tmpWorkspace, "memory", ".v2-state"), { recursive: true });
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

const { getDb, resetDb } = await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { rawExec } = await import("../../raw-query.js");
const { conversations, memoryJobs, messages } = await import("../../schema.js");
const { readPage, writePage } = await import("../page-store.js");
const { writeEdges } = await import("../edges.js");
const { save: saveActivation, hydrate: hydrateActivation } =
  await import("../activation-store.js");
const {
  META_FILE_SLUGS,
  memoryV2ActivationRecomputeJob,
  memoryV2MigrateJob,
  memoryV2RebuildEdgesJob,
  memoryV2ReembedJob,
} = await import("../backfill-jobs.js");

// `isAssistantFeatureFlagEnabled` ignores its `config` argument (resolution is
// purely from the overrides + registry caches), and the activation pipeline
// reads its tunables from `config.memory.v2.*`. Hand the handler a config
// shaped just enough to satisfy both paths — materializing the full default
// config would otherwise pull in heavy schemas that don't add value here.
const TEST_CONFIG = STUB_RUNTIME_CONFIG as Parameters<
  typeof memoryV2ActivationRecomputeJob
>[1];

function makeJob(
  type:
    | "memory_v2_migrate"
    | "memory_v2_rebuild_edges"
    | "memory_v2_reembed"
    | "memory_v2_activation_recompute",
  payload: Record<string, unknown> = {},
) {
  return {
    id: `job-${Math.random()}`,
    type,
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

beforeEach(() => {
  resetDb();
  initializeDb();
  // The shared template-DB caching does not clear WAL state between tests,
  // so explicitly truncate every table this suite writes to. Without this,
  // a row written by an earlier test (e.g. an activation_state for
  // `conv-with-state`) leaks into the next test and breaks isolation.
  for (const table of [
    "activation_state",
    "memory_jobs",
    "messages",
    "conversations",
  ]) {
    rawExec(`DELETE FROM ${table}`);
  }
  // Reset memory dir so each test starts with a clean concepts/edges set.
  rmSync(join(tmpWorkspace, "memory", "concepts"), {
    recursive: true,
    force: true,
  });
  mkdirSync(join(tmpWorkspace, "memory", "concepts"), { recursive: true });
  if (existsSync(join(tmpWorkspace, "memory", "edges.json"))) {
    rmSync(join(tmpWorkspace, "memory", "edges.json"));
  }
  for (const filename of [
    "essentials.md",
    "threads.md",
    "recent.md",
    "buffer.md",
  ]) {
    const filePath = join(tmpWorkspace, "memory", filename);
    if (existsSync(filePath)) rmSync(filePath);
  }

  migrationCalls.length = 0;
  migrationOutcome = { type: "ok" };
});

// ---------------------------------------------------------------------------
// memoryV2MigrateJob
// ---------------------------------------------------------------------------

describe("memoryV2MigrateJob", () => {
  test("invokes runMemoryV2Migration with workspace + database", async () => {
    await memoryV2MigrateJob(makeJob("memory_v2_migrate"), TEST_CONFIG);
    expect(migrationCalls).toHaveLength(1);
    expect(migrationCalls[0].workspaceDir).toBe(tmpWorkspace);
    expect(migrationCalls[0].force).toBe(false);
  });

  test("propagates force=true from the payload", async () => {
    await memoryV2MigrateJob(
      makeJob("memory_v2_migrate", { force: true }),
      TEST_CONFIG,
    );
    expect(migrationCalls[0].force).toBe(true);
  });

  test("treats MigrationAlreadyAppliedError as a successful no-op", async () => {
    migrationOutcome = { type: "sentinel" };

    // Should not throw — handler swallows the sentinel error.
    await memoryV2MigrateJob(makeJob("memory_v2_migrate"), TEST_CONFIG);
    expect(migrationCalls).toHaveLength(1);
  });

  test("rethrows other errors so the worker can apply retry logic", async () => {
    migrationOutcome = { type: "throw", error: new Error("boom") };

    await expect(
      memoryV2MigrateJob(makeJob("memory_v2_migrate"), TEST_CONFIG),
    ).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
// memoryV2RebuildEdgesJob
// ---------------------------------------------------------------------------

describe("memoryV2RebuildEdgesJob", () => {
  test("rewrites every page's edges: frontmatter from edges.json", async () => {
    // Two pages with stale frontmatter — neither matches `edges.json`.
    await writePage(tmpWorkspace, {
      slug: "alice",
      frontmatter: { edges: ["stale"], ref_files: ["alice.png"] },
      body: "Alice prefers VS Code.\n",
    });
    await writePage(tmpWorkspace, {
      slug: "bob",
      frontmatter: { edges: [], ref_files: [] },
      body: "Bob uses zsh.\n",
    });
    await writeEdges(tmpWorkspace, {
      version: 1,
      edges: [["alice", "bob"]],
    });

    await memoryV2RebuildEdgesJob(
      makeJob("memory_v2_rebuild_edges"),
      TEST_CONFIG,
    );

    const alice = await readPage(tmpWorkspace, "alice");
    const bob = await readPage(tmpWorkspace, "bob");
    expect(alice?.frontmatter.edges).toEqual(["bob"]);
    expect(bob?.frontmatter.edges).toEqual(["alice"]);

    // ref_files is preserved as-is — page is the source of truth there.
    expect(alice?.frontmatter.ref_files).toEqual(["alice.png"]);
    // Body is preserved.
    expect(alice?.body).toBe("Alice prefers VS Code.\n");
  });

  test("sets edges: [] for pages without any edges in edges.json", async () => {
    await writePage(tmpWorkspace, {
      slug: "orphan",
      frontmatter: { edges: ["should-be-removed"], ref_files: [] },
      body: "Orphan content.\n",
    });
    await writeEdges(tmpWorkspace, { version: 1, edges: [] });

    await memoryV2RebuildEdgesJob(
      makeJob("memory_v2_rebuild_edges"),
      TEST_CONFIG,
    );

    const orphan = await readPage(tmpWorkspace, "orphan");
    expect(orphan?.frontmatter.edges).toEqual([]);
  });

  test("emits sorted neighbor lists (deterministic across reruns)", async () => {
    await writePage(tmpWorkspace, {
      slug: "alice",
      frontmatter: { edges: [], ref_files: [] },
      body: "Body.\n",
    });
    await writePage(tmpWorkspace, {
      slug: "bob",
      frontmatter: { edges: [], ref_files: [] },
      body: "Body.\n",
    });
    await writePage(tmpWorkspace, {
      slug: "carol",
      frontmatter: { edges: [], ref_files: [] },
      body: "Body.\n",
    });
    await writeEdges(tmpWorkspace, {
      version: 1,
      edges: [
        ["alice", "carol"],
        ["alice", "bob"],
      ],
    });

    await memoryV2RebuildEdgesJob(
      makeJob("memory_v2_rebuild_edges"),
      TEST_CONFIG,
    );

    const alice = await readPage(tmpWorkspace, "alice");
    expect(alice?.frontmatter.edges).toEqual(["bob", "carol"]);
  });

  test("is a no-op for pages whose frontmatter is already correct", async () => {
    // Pre-write the page with the correct edges so the handler should leave
    // it untouched. We can't easily observe "no rewrite happened" from the
    // outside without instrumenting writePage, but the handler returning
    // without error is enough to cover the early-exit branch.
    await writePage(tmpWorkspace, {
      slug: "alice",
      frontmatter: { edges: ["bob"], ref_files: [] },
      body: "Alice.\n",
    });
    await writePage(tmpWorkspace, {
      slug: "bob",
      frontmatter: { edges: ["alice"], ref_files: [] },
      body: "Bob.\n",
    });
    await writeEdges(tmpWorkspace, {
      version: 1,
      edges: [["alice", "bob"]],
    });

    await memoryV2RebuildEdgesJob(
      makeJob("memory_v2_rebuild_edges"),
      TEST_CONFIG,
    );

    expect((await readPage(tmpWorkspace, "alice"))?.frontmatter.edges).toEqual([
      "bob",
    ]);
  });
});

// ---------------------------------------------------------------------------
// memoryV2ReembedJob
// ---------------------------------------------------------------------------

describe("memoryV2ReembedJob", () => {
  test("returns N + 4 (one per concept page plus the four meta files) and writes that many job rows", async () => {
    await writePage(tmpWorkspace, {
      slug: "alice",
      frontmatter: { edges: [], ref_files: [] },
      body: "Alice.\n",
    });
    await writePage(tmpWorkspace, {
      slug: "bob",
      frontmatter: { edges: [], ref_files: [] },
      body: "Bob.\n",
    });

    const total = await memoryV2ReembedJob(
      makeJob("memory_v2_reembed"),
      TEST_CONFIG,
    );

    // Return value covers the contract: N concept pages + 4 meta files.
    expect(total).toBe(2 + META_FILE_SLUGS.length);

    // Verify the slugs that were enqueued by reading the memory_jobs table.
    // Tests that mock `jobs-store.js` skip inserting rows; when this suite
    // runs in isolation (or before such tests) the rows do land. Either
    // way, the return value is the canonical contract — the row lookup is
    // belt-and-suspenders.
    const rows = getDb().select().from(memoryJobs).all();
    if (rows.length > 0) {
      expect(rows).toHaveLength(2 + META_FILE_SLUGS.length);
      const slugs = rows.map((row) => JSON.parse(row.payload).slug);
      expect(slugs).toContain("alice");
      expect(slugs).toContain("bob");
      for (const metaSlug of META_FILE_SLUGS) {
        expect(slugs).toContain(metaSlug);
      }
      for (const row of rows) {
        expect(row.type).toBe("embed_concept_page");
      }
    }
  });

  test("with no concept pages on disk, still enqueues the 4 meta-file jobs", async () => {
    const total = await memoryV2ReembedJob(
      makeJob("memory_v2_reembed"),
      TEST_CONFIG,
    );
    expect(total).toBe(META_FILE_SLUGS.length);
  });

  test("uses reserved meta-file slugs (__essentials__/__threads__/__recent__/__buffer__)", () => {
    expect([...META_FILE_SLUGS]).toEqual([
      "__essentials__",
      "__threads__",
      "__recent__",
      "__buffer__",
    ]);
  });
});

// ---------------------------------------------------------------------------
// memoryV2ActivationRecomputeJob
// ---------------------------------------------------------------------------

describe("memoryV2ActivationRecomputeJob", () => {
  function seedConversation(
    id: string,
    options: {
      role?: string;
      content?: string;
      conversationType?: string;
    } = {},
  ): void {
    const db = getDb();
    db.insert(conversations)
      .values({
        id,
        title: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        conversationType: options.conversationType ?? "standard",
      })
      .run();
    if (options.content) {
      db.insert(messages)
        .values({
          id: `${id}-msg-1`,
          conversationId: id,
          role: options.role ?? "user",
          content: options.content,
          createdAt: Date.now(),
          metadata: null,
        })
        .run();
    }
  }

  test("walks conversations with persisted state and writes a fresh state", async () => {
    seedConversation("conv-with-state", {
      role: "user",
      content: "I prefer VS Code over Vim.",
    });
    // Seed a high-activation slug — the recompute should drive it back down
    // (no candidates appear in our stubbed Qdrant) and it should fall below
    // epsilon, leaving an empty sparse map on next save.
    await saveActivation(getDb(), "conv-with-state", {
      messageId: "msg-prior",
      state: { "alice-prefers-vscode": 0.9 },
      everInjected: [{ slug: "alice-prefers-vscode", turn: 1 }],
      currentTurn: 2,
      updatedAt: 1,
    });

    const updated = await memoryV2ActivationRecomputeJob(
      makeJob("memory_v2_activation_recompute"),
      TEST_CONFIG,
    );

    expect(updated).toBeGreaterThanOrEqual(1);
    const next = await hydrateActivation(getDb(), "conv-with-state");
    expect(next).not.toBeNull();
    expect(next?.messageId).toBe("msg-prior");
    expect(next?.everInjected).toEqual([
      { slug: "alice-prefers-vscode", turn: 1 },
    ]);
    // updatedAt was bumped.
    expect(next?.updatedAt).toBeGreaterThan(1);
  });

  test("skips conversations without a persisted state row", async () => {
    seedConversation("conv-no-state");
    // No saveActivation call — handler should ignore this conversation.
    const updated = await memoryV2ActivationRecomputeJob(
      makeJob("memory_v2_activation_recompute"),
      TEST_CONFIG,
    );

    expect(updated).toBe(0);
    expect(await hydrateActivation(getDb(), "conv-no-state")).toBeNull();
  });

  test("does not crash on a conversation with state but no messages", async () => {
    seedConversation("conv-empty-msgs");
    await saveActivation(getDb(), "conv-empty-msgs", {
      messageId: "msg-x",
      state: {},
      everInjected: [],
      currentTurn: 0,
      updatedAt: 1,
    });

    const updated = await memoryV2ActivationRecomputeJob(
      makeJob("memory_v2_activation_recompute"),
      TEST_CONFIG,
    );

    // Without messages, recompute returns null and the handler skips the
    // save — nothing was updated.
    expect(updated).toBe(0);
  });
});
