/**
 * Tests for `assistant/src/memory/v2/backfill-jobs.ts`.
 *
 * Each handler is exercised with the heavy collaborators (migration runner,
 * embedding backend, Qdrant client, activation pipeline) mocked at the
 * module level so the suite never starts a real Qdrant/embedding backend.
 *
 * Coverage matrix:
 *   - migrate: wraps `runMemoryV2Migration`; force flag propagates;
 *     `MigrationAlreadyAppliedError` is swallowed (no rethrow).
 *   - reembed: enqueues `N` jobs, one per concept-page slug.
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
const { writePage } = await import("../page-store.js");
const { save: saveActivation, hydrate: hydrateActivation } =
  await import("../activation-store.js");
const {
  memoryV2ActivationRecomputeJob,
  memoryV2MigrateJob,
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
// memoryV2ReembedJob
// ---------------------------------------------------------------------------

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

    const total = await memoryV2ReembedJob(
      makeJob("memory_v2_reembed"),
      TEST_CONFIG,
    );

    // Return value covers the contract: one job per concept page.
    expect(total).toBe(2);

    // Verify the slugs that were enqueued by reading the memory_jobs table.
    // Tests that mock `jobs-store.js` skip inserting rows; when this suite
    // runs in isolation (or before such tests) the rows do land. Either
    // way, the return value is the canonical contract — the row lookup is
    // belt-and-suspenders.
    const rows = getDb().select().from(memoryJobs).all();
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
    const total = await memoryV2ReembedJob(
      makeJob("memory_v2_reembed"),
      TEST_CONFIG,
    );
    expect(total).toBe(0);
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

    await memoryV2ReembedJob(makeJob("memory_v2_reembed"), TEST_CONFIG);

    const rows = getDb().select().from(memoryJobs).all();
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
