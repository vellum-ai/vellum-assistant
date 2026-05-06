/**
 * Tests for the v2 routing wired into `ConversationGraphMemory.prepareMemory`.
 *
 * The wiring layer at `conversation-graph-memory.ts` reads two signals to
 * decide whether to swap v1's injection step for the v2 activation pipeline:
 *
 *   1. The `memory-v2-enabled` feature flag (`isAssistantFeatureFlagEnabled`).
 *   2. The workspace config value `memory.v2.enabled`.
 *
 * Both must be true for v2 to take over. This file uses the *real*
 * `injectMemoryV2Block` and stubs only the lower-level deps (Qdrant client,
 * embedding backend) the way `memory/v2/__tests__/injection.test.ts` does —
 * mocking `injection.js` itself would clobber that sibling test when both
 * files run in the same `bun test` invocation, since `mock.module` is
 * process-global. Avoiding the mock keeps the suite hermetic in either order.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
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

import { drizzle } from "drizzle-orm/bun-sqlite";

import type { AssistantConfig } from "../../../config/types.js";
import type { Message } from "../../../providers/types.js";

// ---------------------------------------------------------------------------
// Module mocks (must precede the dynamic imports below)
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Stub the v1 retriever so we don't reach Qdrant. Both modes return zero
// nodes — the v1 injection branch becomes a no-op, isolating the assertion
// to "did the v2 routing fire?". Tracked via `mock()` so tests can also
// assert that v1 retrieval is *not* called when v2 is enabled.
const loadContextMemoryMock = mock(async () => ({
  nodes: [],
  serendipityNodes: [],
  latencyMs: 1,
  metrics: null,
  queryVector: undefined,
  sparseVector: undefined,
  userQueryVector: undefined,
  userQuerySparseVector: undefined,
}));
const retrieveForTurnMock = mock(async () => ({
  nodes: [],
  latencyMs: 1,
  metrics: null,
  queryVector: undefined,
  sparseVector: undefined,
}));
mock.module("../retriever.js", () => ({
  loadContextMemory: loadContextMemoryMock,
  retrieveForTurn: retrieveForTurnMock,
}));

// Programmable embedding + Qdrant state. Mirrors the pattern in
// `memory/v2/__tests__/injection.test.ts` so we drive the real
// `injectMemoryV2Block` end-to-end without a live backend.
const qdrantState = {
  queryResponses: {
    dense: [] as Array<{
      points: Array<{ score?: number; payload: Record<string, unknown> }>;
    }>,
    sparse: [] as Array<{
      points: Array<{ score?: number; payload: Record<string, unknown> }>;
    }>,
  },
};

class MockQdrantClient {
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
  async query(
    _name: string,
    params: { using: string; limit: number; filter?: unknown },
  ) {
    const queue =
      qdrantState.queryResponses[params.using as "dense" | "sparse"];
    return queue.shift() ?? { points: [] };
  }
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: MockQdrantClient,
}));

const realEmbeddingBackend = await import("../../embedding-backend.js");
mock.module("../../embedding-backend.js", () => ({
  ...realEmbeddingBackend,
  embedWithBackend: async () => ({
    provider: "local",
    model: "test-model",
    vectors: [[0.1, 0.2, 0.3]] as number[][],
  }),
  generateSparseEmbedding: () => ({
    indices: [1, 2, 3],
    values: [0.5, 0.5, 0.5] as number[],
  }),
}));

const realQdrantClient = await import("../../qdrant-client.js");
mock.module("../../qdrant-client.js", () => ({
  ...realQdrantClient,
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

// ---------------------------------------------------------------------------
// Workspace + DB fixtures
// ---------------------------------------------------------------------------

let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "conv-graph-v2-routing-test-"));
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

  // Seed v2 layout with a single concept page so the real injection module
  // has something concrete to render. Generic placeholders only.
  mkdirSync(join(tmpWorkspace, "memory", "concepts"), { recursive: true });
  writeFileSync(
    join(tmpWorkspace, "memory", "concepts", "alice-vscode.md"),
    `---\nedges: []\nref_files: []\n---\nAlice prefers VS Code as her editor.`,
  );
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
  // Restore mocks so a sibling test loaded in the same `bun test` run sees
  // unmocked module bindings.
  mock.restore();
});

// ---------------------------------------------------------------------------
// Dynamic imports — must come AFTER the mock.module() calls above so the
// bindings resolve through the stubs.
// ---------------------------------------------------------------------------

import type { DrizzleDb } from "../../db-connection.js";

const { ConversationGraphMemory } =
  await import("../conversation-graph-memory.js");
const { _setOverridesForTesting } =
  await import("../../../config/assistant-feature-flags.js");
const { applyNestedDefaults } = await import("../../../config/loader.js");
const { getSqliteFrom } = await import("../../db-connection.js");
const { migrateActivationState } =
  await import("../../migrations/232-activation-state.js");
const schema = await import("../../schema.js");
const { _resetMemoryV2QdrantForTests } = await import("../../v2/qdrant.js");

// The wiring layer calls `getDb()` to fetch the SQLite handle. We mock
// only that one export and spread the real module so unrelated callers
// (`raw*` helpers, etc.) keep working when this test runs alongside
// others. A live mutable holder lets each `beforeEach` swap the handle
// without re-registering the mock.
let testDbHandle: DrizzleDb | null = null;
const realDbModule = await import("../../db-connection.js");
mock.module("../../db-connection.js", () => ({
  ...realDbModule,
  getDb: () => {
    if (!testDbHandle) throw new Error("test db not initialized");
    return testDbHandle;
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): DrizzleDb {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  getSqliteFrom(db).exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  migrateActivationState(db);
  return db;
}

function makeConfig(v2Enabled: boolean): AssistantConfig {
  return applyNestedDefaults({
    memory: { v2: { enabled: v2Enabled } },
  }) as AssistantConfig;
}

function makeMessages(
  text = "hello there, this is a long enough question",
): Message[] {
  return [
    {
      role: "user",
      content: [{ type: "text" as const, text }],
    },
  ];
}

function makeMemory(): InstanceType<typeof ConversationGraphMemory> {
  // `initialized = true` skips the context-load branch and the
  // `fetchRecentSummaries` DB read it depends on, isolating the per-turn path
  // for these unit tests. Context-load is covered by its own block below.
  const m = new ConversationGraphMemory("conv-test-1");
  (m as unknown as { initialized: boolean }).initialized = true;
  return m;
}

/** Stage one set of dense/sparse hits for each channel of the activation
 *  pipeline (1 candidate query + 3 simBatch channels). */
function stageTurn(
  hits: Array<{ slug: string; denseScore?: number; sparseScore?: number }>,
): void {
  for (let i = 0; i < 4; i++) {
    qdrantState.queryResponses.dense.push({
      points: hits
        .filter((h) => h.denseScore !== undefined)
        .map((h) => ({ score: h.denseScore, payload: { slug: h.slug } })),
    });
    qdrantState.queryResponses.sparse.push({
      points: hits
        .filter((h) => h.sparseScore !== undefined)
        .map((h) => ({ score: h.sparseScore, payload: { slug: h.slug } })),
    });
  }
}

const noopEvent = () => {};

beforeEach(() => {
  testDbHandle = createTestDb();
  qdrantState.queryResponses.dense.length = 0;
  qdrantState.queryResponses.sparse.length = 0;
  loadContextMemoryMock.mockClear();
  retrieveForTurnMock.mockClear();
  _resetMemoryV2QdrantForTests();
});

afterEach(() => {
  _setOverridesForTesting({});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationGraphMemory.prepareMemory — v2 routing (per-turn path)", () => {
  test("flag off → v2 not run, messages unchanged", async () => {
    _setOverridesForTesting({ "memory-v2-enabled": false });
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);

    const memory = makeMemory();
    const config = makeConfig(true);
    const messages = makeMessages();

    const result = await memory.prepareMemory(
      messages,
      config,
      new AbortController().signal,
      noopEvent,
    );

    expect(result.mode).toBe("per-turn");
    expect(result.injectedBlockText).toBeNull();
    // No v2 block prepended — the v1 retriever returned zero nodes so the
    // user message is exactly the input.
    expect(result.runMessages).toEqual(messages);
  });

  test("flag on + config off → v2 not run, messages unchanged", async () => {
    _setOverridesForTesting({ "memory-v2-enabled": true });
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);

    const memory = makeMemory();
    const config = makeConfig(false);
    const messages = makeMessages();

    const result = await memory.prepareMemory(
      messages,
      config,
      new AbortController().signal,
      noopEvent,
    );

    expect(result.mode).toBe("per-turn");
    expect(result.injectedBlockText).toBeNull();
    expect(result.runMessages).toEqual(messages);
  });

  test("flag on + config on → v2 block prepended, mode is per-turn", async () => {
    _setOverridesForTesting({ "memory-v2-enabled": true });
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);

    const memory = makeMemory();
    const config = makeConfig(true);
    const messages = makeMessages("Tell me about Alice's editor preferences");

    const result = await memory.prepareMemory(
      messages,
      config,
      new AbortController().signal,
      noopEvent,
    );

    expect(result.mode).toBe("per-turn");
    expect(result.injectedBlockText).not.toBeNull();
    expect(result.injectedBlockText).not.toContain("<memory>");
    expect(result.injectedBlockText).toContain("### alice-vscode");

    // The leading content block on the user message is the v2 block,
    // wrapped exactly once.
    const lastMsg = result.runMessages[result.runMessages.length - 1];
    expect(lastMsg?.role).toBe("user");
    const firstBlock = lastMsg?.content[0];
    expect(firstBlock?.type).toBe("text");
    if (firstBlock?.type !== "text") throw new Error("unexpected block type");
    expect(firstBlock.text.startsWith("<memory>\n")).toBe(true);
    expect(firstBlock.text.endsWith("\n</memory>")).toBe(true);
    // No nested wrapper.
    expect(firstBlock.text.match(/<memory>/g)?.length).toBe(1);

    // v1 retrieval is fully bypassed when v2 is enabled.
    expect(retrieveForTurnMock).not.toHaveBeenCalled();
  });

  test("reinjectCachedMemory after v2 injection wraps exactly once (no double-wrap)", async () => {
    // Regression for the double-wrap bug: v2 cached `lastInjectedBlock`
    // already wrapped, then `reinjectCachedMemory` re-wrapped via
    // `injectTextBlock`, producing `<memory>\n<memory>\n...\n</memory>\n</memory>`.
    _setOverridesForTesting({ "memory-v2-enabled": true });
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);

    const memory = makeMemory();
    const config = makeConfig(true);
    const messages = makeMessages("Tell me about Alice's editor preferences");

    const initial = await memory.prepareMemory(
      messages,
      config,
      new AbortController().signal,
      noopEvent,
    );
    expect(initial.injectedBlockText).not.toBeNull();

    // Simulate post-compaction: caller re-runs `applyRuntimeInjections`
    // (which strips memory injections) and then asks for the cached
    // memory to be re-prepended.
    const reinjected = memory.reinjectCachedMemory(messages);
    const lastMsg = reinjected.runMessages[reinjected.runMessages.length - 1];
    const firstBlock = lastMsg?.content[0];
    expect(firstBlock?.type).toBe("text");
    if (firstBlock?.type !== "text") throw new Error("unexpected block type");
    expect(firstBlock.text.startsWith("<memory>\n")).toBe(true);
    expect(firstBlock.text.endsWith("\n</memory>")).toBe(true);
    expect(firstBlock.text.match(/<memory>/g)?.length).toBe(1);
    expect(firstBlock.text.match(/<\/memory>/g)?.length).toBe(1);
    expect(firstBlock.text).toContain("### alice-vscode");
  });

  test("flag on + config on with empty Qdrant hits → no v2 block, v1 fallback skipped", async () => {
    _setOverridesForTesting({ "memory-v2-enabled": true });
    // No `stageTurn` call — every channel returns `{ points: [] }` so the
    // candidate set is empty and `injectMemoryV2Block` returns block=null.
    const memory = makeMemory();
    const config = makeConfig(true);
    const messages = makeMessages();

    const result = await memory.prepareMemory(
      messages,
      config,
      new AbortController().signal,
      noopEvent,
    );

    expect(result.injectedBlockText).toBeNull();
    expect(result.runMessages).toEqual(messages);
  });
});

describe("ConversationGraphMemory.prepareMemory — v2 routing (context-load path)", () => {
  test("flag on + config on → v2 fires with mode=context-load", async () => {
    _setOverridesForTesting({ "memory-v2-enabled": true });
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);

    // Fresh memory → initialized=false → runContextLoad branch.
    const memory = new ConversationGraphMemory("conv-test-cl");
    const config = makeConfig(true);
    const messages = makeMessages("first message of the conversation here");

    const result = await memory.prepareMemory(
      messages,
      config,
      new AbortController().signal,
      noopEvent,
    );

    expect(result.mode).toBe("context-load");
    expect(result.injectedBlockText).not.toBeNull();
    expect(result.injectedBlockText).toContain("### alice-vscode");
    // injectedBlockText is the unwrapped inner content; the wrapper is
    // applied at injection time on the run message.
    expect(result.injectedBlockText).not.toContain("<memory>");
    const lastMsg = result.runMessages[result.runMessages.length - 1];
    const firstBlock = lastMsg?.content[0];
    if (firstBlock?.type !== "text") throw new Error("unexpected block type");
    expect(firstBlock.text.match(/<memory>/g)?.length).toBe(1);

    // v1 retrieval is fully bypassed when v2 is enabled.
    expect(loadContextMemoryMock).not.toHaveBeenCalled();
  });

  test("flag off → v2 not run on first turn either", async () => {
    _setOverridesForTesting({ "memory-v2-enabled": false });
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);

    const memory = new ConversationGraphMemory("conv-test-cl-off");
    const config = makeConfig(true);
    const messages = makeMessages("first message of the conversation here");

    const result = await memory.prepareMemory(
      messages,
      config,
      new AbortController().signal,
      noopEvent,
    );

    expect(result.mode).toBe("context-load");
    expect(result.injectedBlockText).toBeNull();
  });
});
