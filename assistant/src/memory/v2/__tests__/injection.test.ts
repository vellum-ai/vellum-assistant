/**
 * Tests for `assistant/src/memory/v2/injection.ts`.
 *
 * Coverage matrix:
 *   - Empty state seeds the first injection (initial conversation turn).
 *   - A later turn re-renders the full current top-K every turn (history is
 *     stripped, so nothing persists to dedup against) and reports it in
 *     `toInject`.
 *   - A new topic appearing on a later turn is rendered alongside the
 *     still-relevant carried-forward slugs.
 *   - Unified-pool skills: a `skills/<id>` slug ranked into the top-K is
 *     rendered under `### Skills You Can Use`, mixed concept-page+skill
 *     blocks render concept sections first then the skills suffix, both
 *     empty → null block.
 *
 * Hermetic by design: the embedding backend, qdrant client, and `getConfig`
 * are mocked at the module level so the suite never reaches a real backend.
 * The skill-store cache (`getSkillCapability`, `isSkillSlug`) is mocked so
 * each test can stage skill content without touching the real catalog.
 * The activation-store uses an in-memory SQLite database so writes are
 * real but contained.
 *
 * Tests use a temp workspace (mkdtemp) and never touch `~/.vellum/`. Sample
 * page content uses generic placeholders (Alice, Bob, etc.) per the cross-
 * cutting safety rules.
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
import { z } from "zod";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../../../config/types.js";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

const STUB_QDRANT_CONFIG = {
  memory: {
    qdrant: {
      url: "http://127.0.0.1:6333",
      vectorSize: 384,
      onDisk: true,
    },
  },
};
mock.module("../../../config/loader.js", () => ({
  getConfig: () => STUB_QDRANT_CONFIG,
  loadConfig: () => STUB_QDRANT_CONFIG,
}));

const realQdrantClient = await import("../../qdrant-client.js");
mock.module("../../qdrant-client.js", () => ({
  ...realQdrantClient,
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

// Programmable embedding + Qdrant state — drives `selectCandidates`,
// `simBatch`, and friends without a live backend.
const state = {
  embedReturn: [[0.1, 0.2, 0.3]] as number[][],
  sparseReturn: { indices: [1, 2, 3], values: [0.5, 0.5, 0.5] },
  queryResponses: {
    dense: [] as Array<{
      points: Array<{ score?: number; payload: Record<string, unknown> }>;
    }>,
    sparse: [] as Array<{
      points: Array<{ score?: number; payload: Record<string, unknown> }>;
    }>,
  },
};

const realEmbeddingBackend = await import("../../embedding-backend.js");
mock.module("../../embedding-backend.js", () => ({
  ...realEmbeddingBackend,
  embedWithBackend: async () => ({
    provider: "local",
    model: "test-model",
    vectors: state.embedReturn,
  }),
  generateSparseEmbedding: () => state.sparseReturn,
}));

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
    // The four-channel hybrid query fires body-dense, body-sparse,
    // summary-dense, summary-sparse in order; both dense channels share
    // the dense queue and both sparse channels share the sparse queue.
    const channel = params.using.endsWith("sparse") ? "sparse" : "dense";
    return state.queryResponses[channel].shift() ?? { points: [] };
  }
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: MockQdrantClient,
}));

// ---------------------------------------------------------------------------
// Skill-store mock
// ---------------------------------------------------------------------------
//
// Skills now flow through the unified pipeline under the `skills/<id>` slug
// prefix — they are scored by `simBatch` against the same Qdrant collection
// as concept pages, ranked by `selectInjections`, and rendered alongside
// concept sections. The render path branches on `isSkillSlug(slug)` to fetch
// content from the in-process cache via `getSkillCapability` instead of
// reading a page from disk. Tests stage that cache and rely on the regular
// `stageTurn` plumbing to land skill slugs in the candidate set.

const skillState = {
  /** id → SkillEntry consulted by `getSkillCapability`. */
  entries: new Map<string, SkillEntry>(),
};

mock.module("../skill-store.js", () => ({
  getSkillCapability: (idOrSlug: string) => {
    const id = idOrSlug.startsWith("skills/")
      ? idOrSlug.slice("skills/".length)
      : idOrSlug;
    return skillState.entries.get(id) ?? null;
  },
  isSkillSlug: (slug: string) => slug.startsWith("skills/"),
  SKILL_SLUG_PREFIX: "skills/",
  skillSlugFor: (id: string) => `skills/${id}`,
  // PR 4 added `listSkillEntries`; `page-index.ts` (transitively imported
  // via `page-store.ts` and `skill-store.ts`) consumes it at module-init
  // time. Tests stage skill content via `skillState.entries`; expose them
  // here so the page-index loader sees a consistent view.
  listSkillEntries: () => Array.from(skillState.entries.values()),
}));

// ---------------------------------------------------------------------------
// CLI-command-store mock
// ---------------------------------------------------------------------------
//
// Mirrors the skill-store mock. CLI subcommand synthetic entries flow through
// the unified pipeline under the `cli-commands/<name>` slug prefix and render
// under `### CLI Commands You Can Use`. Tests stage `cliCommandState.entries`
// and rely on `stageTurn` plumbing to land slugs in the candidate set.

interface CliCommandEntryStub {
  id: string;
  description: string;
  content: string;
}

const cliCommandState = {
  entries: new Map<string, CliCommandEntryStub>(),
};

mock.module("../cli-command-store.js", () => ({
  getCliCommandCapability: (idOrSlug: string) => {
    const id = idOrSlug.startsWith("cli-commands/")
      ? idOrSlug.slice("cli-commands/".length)
      : idOrSlug;
    return cliCommandState.entries.get(id) ?? null;
  },
  isCliCommandSlug: (slug: string) => slug.startsWith("cli-commands/"),
  CLI_COMMAND_SLUG_PREFIX: "cli-commands/",
  cliCommandSlugFor: (name: string) => `cli-commands/${name}`,
  listCliCommandEntries: () => Array.from(cliCommandState.entries.values()),
}));

// ---------------------------------------------------------------------------
// Activation-log store mock
// ---------------------------------------------------------------------------
//
// The real `recordMemoryV2ActivationLog` writes to the singleton
// `getDb()` — but this test uses an isolated in-memory database, so we mock
// the writer to capture calls in-process. `recordCalls` is the captured log
// array; `recordShouldThrow` makes the next call throw to verify the caller
// swallows the failure.

const telemetryState = {
  recordCalls: [] as Array<Record<string, unknown>>,
  recordShouldThrow: false,
};

mock.module("../../memory-v2-activation-log-store.js", () => ({
  recordMemoryV2ActivationLog: (params: Record<string, unknown>) => {
    if (telemetryState.recordShouldThrow) {
      throw new Error("simulated telemetry write failure");
    }
    telemetryState.recordCalls.push(params);
  },
}));

// ---------------------------------------------------------------------------
// Page-store mock — pass-through with optional per-slug failure injection
// ---------------------------------------------------------------------------
//
// Most tests want the real `readPage` (it walks the temp workspace seeded in
// `beforeAll`). The error-isolation tests stage a slug whose `readPage` call
// must throw — typically a Zod validation error mimicking the real-world
// "unrecognized frontmatter key" failure that motivated this work. Tests
// stage entries via `pageStoreState.failingSlugs` and reset in `resetState`.
//
// Bun's `mock.module` mutates the module's exports object in place, so
// `realPageStore.readPage` AFTER the mock applies would resolve to the mock
// itself — calling it would recurse. We capture the original function value
// (not a property lookup) before installing the mock so the pass-through
// path has a real reference to the underlying implementation.

const realPageStoreModule = await import("../page-store.js");
const realReadPage = realPageStoreModule.readPage;
const pageStoreState = {
  failingSlugs: new Map<string, Error>(),
};
mock.module("../page-store.js", () => ({
  ...realPageStoreModule,
  readPage: async (workspaceDir: string, slug: string) => {
    const err = pageStoreState.failingSlugs.get(slug);
    if (err) throw err;
    return realReadPage(workspaceDir, slug);
  },
}));

// ---------------------------------------------------------------------------
// Router mock — programmable per-call result
// ---------------------------------------------------------------------------
//
// PR 10 wires `runRouter` into `injectMemoryV2Block` behind the
// `memory.v2.router.enabled` flag. The activation-mode tests above never
// flip the flag, so the default mock returns a no-op result and the router
// branch is never exercised. Router-mode tests set `routerState.nextResult`
// to stage a deterministic outcome before each call.

interface RouterResultStub {
  selectedSlugs: string[];
  failureReason: string | null;
  /** Tier provenance per slug. Defaults to `tier3:0` for any selected slug. */
  sourceBySlug?: Map<string, string>;
}

const routerState = {
  nextResult: null as RouterResultStub | null,
  callCount: 0,
};

mock.module("../router.js", () => ({
  runRouter: async () => {
    routerState.callCount++;
    const result = routerState.nextResult ?? {
      selectedSlugs: [],
      failureReason: null,
    };
    // Synthesize a default sourceBySlug for stubs that don't set one — pre-
    // tier-provenance tests stage `selectedSlugs` only and expect every pick
    // to flow through as a router selection. Treating them as `tier3:0` is
    // the closest equivalent under the new model.
    if (!result.sourceBySlug) {
      const map = new Map<string, string>();
      for (const slug of result.selectedSlugs) map.set(slug, "tier3:0");
      result.sourceBySlug = map;
    }
    return result;
  },
}));

// ---------------------------------------------------------------------------
// Activation-store mock — pass-through with optional `save` failure injection
// ---------------------------------------------------------------------------
//
// One regression test forces `save` to throw to exercise the
// `injectMemoryV2Block` outer try/finally — telemetry must still be flushed
// (with `mode: "errored"`) and the error must propagate. Default behavior
// delegates to the real activation-store so the rest of the suite stays
// untouched. Same pre-mock function-capture trick as `readPage` above.

const realActivationStoreModule = await import("../activation-store.js");
const realSave = realActivationStoreModule.save;
const activationStoreState = {
  saveShouldThrow: false,
};
mock.module("../activation-store.js", () => ({
  ...realActivationStoreModule,
  save: async (...args: Parameters<typeof realSave>) => {
    if (activationStoreState.saveShouldThrow) {
      throw new Error("simulated activation-store save failure");
    }
    return realSave(...args);
  },
}));

// ---------------------------------------------------------------------------
// Workspace + DB setup
// ---------------------------------------------------------------------------

let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "memory-v2-injection-test-"));
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

  // Seed the v2 directory layout the migration would normally create.
  mkdirSync(join(tmpWorkspace, "memory", "concepts"), { recursive: true });
  // Three concept pages with generic, placeholder bodies. Outgoing edges
  // live in each page's frontmatter `edges:` list — there is no separate
  // edges-index file under the directed-edges model.
  writeFileSync(
    join(tmpWorkspace, "memory", "concepts", "alice-vscode.md"),
    `---
edges: [bob-coffee]
ref_files: []
---
Alice prefers VS Code as her editor.`,
  );
  writeFileSync(
    join(tmpWorkspace, "memory", "concepts", "bob-coffee.md"),
    `---
edges: [alice-vscode]
ref_files: []
---
Bob takes his coffee black, no sugar.`,
  );
  writeFileSync(
    join(tmpWorkspace, "memory", "concepts", "carol-jazz.md"),
    `---
edges: []
ref_files: []
---
Carol loves jazz music — Coltrane in particular.`,
  );
  // A page with both `edges` and `ref_files` populated so the frontmatter-
  // injection test can assert the full canonical shape.
  writeFileSync(
    join(tmpWorkspace, "memory", "concepts", "frontmatter-demo.md"),
    `---
edges:
  - alice-vscode
ref_files:
  - images/demo.jpg
---
Demo body content.`,
  );
  // A page WITH a `summary` in its frontmatter — exercises the summary-only
  // injection path. Body is intentionally longer than the summary so tests
  // can assert that the body is *not* injected when the summary is present.
  writeFileSync(
    join(tmpWorkspace, "memory", "concepts", "summarized-page.md"),
    `---
edges: []
ref_files: []
summary: A short prose description of the summarized page that retrieval injects in place of the full body.
---
Long-form body content that should NOT appear in the injection block when the page has a summary in frontmatter — the agent reads the file on demand instead.`,
  );
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

// Static `import type` is fine — types erase, so they don't run module-init
// code that would race the mocks above.
import type { DrizzleDb } from "../../db-connection.js";
import type { SkillEntry } from "../types.js";

const { getSqliteFrom } = await import("../../db-connection.js");
const { migrateActivationState } =
  await import("../../migrations/232-activation-state.js");
const { migrateMemoryV2InjectionEvents } =
  await import("../../migrations/256-memory-v2-injection-events.js");
const schema = await import("../../schema.js");
const { hydrate } = await import("../activation-store.js");
const { injectMemoryV2Block } = await import("../injection.js");
const { _resetMemoryV2QdrantForTests } = await import("../qdrant.js");

function createTestDb(): DrizzleDb {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });

  // Migration uses the checkpoints table for crash recovery — bootstrap it.
  getSqliteFrom(db).exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  migrateActivationState(db);
  migrateMemoryV2InjectionEvents(db);
  return db;
}

function makeConfig(
  overrides: Partial<{
    d: number;
    c_user: number;
    c_assistant: number;
    c_now: number;
    k: number;
    hops: number;
    top_k: number;
    epsilon: number;
    dense_weight: number;
    sparse_weight: number;
    router: { enabled: boolean; max_page_ids?: number };
  }> = {},
): AssistantConfig {
  const { router, ...rest } = overrides;
  return {
    memory: {
      v2: {
        d: 0.3,
        c_user: 0.3,
        c_assistant: 0.2,
        c_now: 0.2,
        k: 0.5,
        hops: 2,
        top_k: 25,
        epsilon: 0.01,
        dense_weight: 1.0,
        sparse_weight: 0.0,
        router: { enabled: false, max_page_ids: 25, ...(router ?? {}) },
        ...rest,
      },
    },
  } as unknown as AssistantConfig;
}

/**
 * Stage one set of dense/sparse hits, used uniformly by every `simBatch`
 * channel call (user/assistant/now) AND by the un-restricted ANN candidate
 * query. The candidate query runs first, then three simBatch calls — that's
 * `channels` (= 4) logical hybrid queries. Each logical hybrid query now
 * fires a four-channel fan-out (body dense, body sparse, summary dense,
 * summary sparse), so we push 2 dense + 2 sparse responses per logical
 * call to match the post-summary-vector wire pattern.
 *
 * Each entry is mapped to a hit per channel; pass `denseScore`/`sparseScore`
 * undefined to omit a slug from that channel. `summaryDenseScore` /
 * `summarySparseScore` route to the summary-side channels — tests that
 * don't care about summary scoring leave them undefined and the summary
 * channel falls back to body-only behavior.
 */
function stageTurn(
  hits: Array<{
    slug: string;
    denseScore?: number;
    sparseScore?: number;
    summaryDenseScore?: number;
    summarySparseScore?: number;
  }>,
  channels = 4,
): void {
  // Clear any leftovers from a prior turn before staging this one so unused
  // staged responses can't bleed into the next injection. The activation
  // pipeline now skips the embedding round-trip for empty texts (turn 1's
  // assistantMessage), so consumed-channel counts vary per turn — staging
  // exclusively is the only way multi-turn tests stay aligned.
  state.queryResponses.dense.length = 0;
  state.queryResponses.sparse.length = 0;
  for (let i = 0; i < channels; i++) {
    state.queryResponses.dense.push({
      points: hits
        .filter((h) => h.denseScore !== undefined)
        .map((h) => ({ score: h.denseScore, payload: { slug: h.slug } })),
    });
    state.queryResponses.sparse.push({
      points: hits
        .filter((h) => h.sparseScore !== undefined)
        .map((h) => ({ score: h.sparseScore, payload: { slug: h.slug } })),
    });
    state.queryResponses.dense.push({
      points: hits
        .filter((h) => h.summaryDenseScore !== undefined)
        .map((h) => ({
          score: h.summaryDenseScore,
          payload: { slug: h.slug },
        })),
    });
    state.queryResponses.sparse.push({
      points: hits
        .filter((h) => h.summarySparseScore !== undefined)
        .map((h) => ({
          score: h.summarySparseScore,
          payload: { slug: h.slug },
        })),
    });
  }
}

function resetState(): void {
  state.embedReturn = [[0.1, 0.2, 0.3]];
  state.sparseReturn = { indices: [1, 2, 3], values: [0.5, 0.5, 0.5] };
  state.queryResponses.dense.length = 0;
  state.queryResponses.sparse.length = 0;
  skillState.entries.clear();
  cliCommandState.entries.clear();
  telemetryState.recordCalls.length = 0;
  telemetryState.recordShouldThrow = false;
  pageStoreState.failingSlugs.clear();
  activationStoreState.saveShouldThrow = false;
  routerState.nextResult = null;
  routerState.callCount = 0;
  // The qdrant module caches its client; the cached client may be a
  // MockQdrantClient instance from a sibling test file. Reset to force a
  // fresh `new QdrantClient()` against this file's mock.
  _resetMemoryV2QdrantForTests();
}

/** Stage skill-store cache entries for the upcoming render. */
function stageSkills(entries: SkillEntry[]): void {
  for (const entry of entries) {
    skillState.entries.set(entry.id, entry);
  }
}

/** Stage cli-command-store cache entries for the upcoming render. */
function stageCliCommands(entries: CliCommandEntryStub[]): void {
  for (const entry of entries) {
    cliCommandState.entries.set(entry.id, entry);
  }
}

let db: DrizzleDb;
beforeEach(() => {
  db = createTestDb();
  resetState();
});
afterEach(resetState);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("injectMemoryV2Block", () => {
  test("seeds first injection from an empty state", async () => {
    // First turn: no prior state. The ANN candidate call surfaces alice; the
    // three simBatch channels score her highly enough to dominate top-K.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Tell me about Alice's editor" },
      ],
      nowText: "Spring afternoon",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual(["alice-vscode"]);
    expect(result.block).not.toBeNull();
    // `block` is the unwrapped inner content; the caller adds the
    // `<memory>...</memory>` wrapper exactly once at injection time.
    expect(result.block).not.toContain("<memory>");
    expect(result.block).not.toContain("</memory>");
    expect(result.block).not.toContain("## What I Remember Right Now");
    expect(result.block).toContain("# memory/concepts/alice-vscode.md");
    expect(result.block).toContain("VS Code");

    // State persisted: alice's activation is above epsilon and recorded.
    const persisted = await hydrate(db, "conv-1");
    expect(persisted).not.toBeNull();
    expect(persisted!.state["alice-vscode"]).toBeGreaterThan(0.01);
    expect(persisted!.currentTurn).toBe(1);
    expect(persisted!.messageId).toBe("msg-1");
  });

  test("second turn re-renders the still-relevant slug into the block", async () => {
    // Turn 1 — seed alice as injected.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Alice's editor" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // Turn 2 — the same slug is still top-of-mind. We render the full top-K
    // every turn (history is stripped, so nothing persists to dedup against),
    // so alice is re-rendered into the block and reported in `toInject`.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      recentTurnPairs: [
        {
          assistantMessage: "Alice loves it.",
          userMessage: "And what about VS Code?",
        },
      ],
      nowText: "Now",
      messageId: "msg-2",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual(["alice-vscode"]);
    expect(result.block).not.toBeNull();
    expect(result.block).toContain("# memory/concepts/alice-vscode.md");

    // State still advanced (currentTurn moved forward).
    const persisted = await hydrate(db, "conv-1");
    expect(persisted!.currentTurn).toBe(2);
    expect(persisted!.messageId).toBe("msg-2");
  });

  test("new topic appears → block and toInject both carry the full top-K", async () => {
    // Turn 1 — seed alice.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Editor preferences" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // Turn 2 — carol is now in the candidate pool with high relevance.
    // Both alice (carry-forward) and carol appear in topNow and are rendered
    // into the block (full top-K each turn), and both are reported in
    // `toInject` — there is no first-seen dedup anymore.
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.6 },
      { slug: "carol-jazz", denseScore: 0.95 },
    ]);
    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      recentTurnPairs: [
        {
          assistantMessage: "",
          userMessage: "Tell me about Carol's music taste",
        },
      ],
      nowText: "Now",
      messageId: "msg-2",
      config: makeConfig(),
    });

    expect(new Set(result.toInject)).toEqual(
      new Set(["carol-jazz", "alice-vscode"]),
    );
    // The block re-renders the full current top-K — both carol AND alice —
    // because history is stripped and nothing persists on prior turns.
    expect(result.block).toContain("# memory/concepts/carol-jazz.md");
    expect(result.block).toContain("# memory/concepts/alice-vscode.md");
  });

  test("page with summary renders as path + summary, no body, with the CRITICAL header", async () => {
    // Pages whose frontmatter carries a `summary` should inject only the
    // summary text behind the path header — the agent reads the full file
    // on demand. The leading `**CRITICAL:**` line tells the agent how to
    // read the block.
    stageTurn([{ slug: "summarized-page", denseScore: 0.9 }]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        {
          assistantMessage: "",
          userMessage: "tell me about the summarized page",
        },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.block).not.toBeNull();
    expect(result.block).toContain(
      'Use `file_read("memory/concepts/path/to/file.md")` to read the full pages for any of the injected memory summaries you want more information on.',
    );
    expect(result.block).toContain(
      "# memory/concepts/summarized-page.md\nA short prose description",
    );
    // Body is NOT in the block — the agent must follow up with a read tool.
    expect(result.block).not.toContain("Long-form body content");
    // Frontmatter is also omitted; the path header carries the identifying
    // information by itself, and edges flow through the activation graph.
    expect(result.block).not.toContain("---\nedges:");
  });

  test("mixed batch — summary page renders short, fallback page renders full", async () => {
    // Both pages rank into top-K. summarized-page has a summary → short
    // form. frontmatter-demo has no summary → full-page fallback. The
    // single CRITICAL header sits at the top regardless.
    stageTurn([
      { slug: "summarized-page", denseScore: 0.95 },
      { slug: "frontmatter-demo", denseScore: 0.85 },
    ]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "show me everything" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.block).not.toBeNull();
    // Header appears exactly once.
    const headerCount = (
      result.block!.match(
        /Use `file_read\("memory\/concepts\/path\/to\/file\.md"\)` to read/g,
      ) ?? []
    ).length;
    expect(headerCount).toBe(1);
    // summarized-page → short form (path + summary, no body, no frontmatter).
    expect(result.block).toContain("# memory/concepts/summarized-page.md\nA");
    expect(result.block).not.toContain("Long-form body content");
    // frontmatter-demo → full-page fallback (path + frontmatter + body).
    expect(result.block).toContain(
      "# memory/concepts/frontmatter-demo.md\n---\n",
    );
    expect(result.block).toContain("Demo body content.");
  });

  test("includes the page frontmatter (edges, ref_files) in each rendered section", async () => {
    // The frontmatter (`edges`, `ref_files`) lives on disk above the page
    // body and is part of the page's content. Injection must reproduce both
    // fields verbatim — bracketed by the canonical `---` delimiters — so the
    // agent sees the page's edges and any referenced media paths alongside
    // the prose body.
    stageTurn([{ slug: "frontmatter-demo", denseScore: 0.9 }]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "show me the demo" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.block).not.toBeNull();
    // Path header is immediately followed by the frontmatter open delimiter.
    // The fallback path renders the full page (frontmatter + body) when the
    // page has no `summary` field — `frontmatter-demo` predates the field.
    expect(result.block).toContain(
      "# memory/concepts/frontmatter-demo.md\n---\n",
    );
    // Both fields render in YAML block style with their populated values.
    expect(result.block).toContain("edges:\n  - alice-vscode");
    expect(result.block).toContain("ref_files:\n  - images/demo.jpg");
    // Body still renders after the closing delimiter.
    expect(result.block).toContain("Demo body content.");
  });

  test("renders pages in activation-descending order", async () => {
    // Both slugs are fresh (no prior state). carol scores higher than alice
    // on every channel — so carol should be ranked first in topNow and
    // therefore appear first in the rendered block.
    stageTurn([
      { slug: "carol-jazz", denseScore: 0.95 },
      { slug: "alice-vscode", denseScore: 0.5 },
    ]);
    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "music and editors" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual(["carol-jazz", "alice-vscode"]);
    const carolIdx = result.block!.indexOf("# memory/concepts/carol-jazz.md");
    const aliceIdx = result.block!.indexOf("# memory/concepts/alice-vscode.md");
    expect(carolIdx).toBeGreaterThan(-1);
    expect(aliceIdx).toBeGreaterThan(-1);
    expect(carolIdx).toBeLessThan(aliceIdx);
  });

  test("persists sparse state — only slugs above epsilon survive", async () => {
    // Carol scores high; alice essentially zero. After saving, only carol
    // should appear in the persisted state map. denseScore is the raw
    // Qdrant cosine in [-1, 1]; alice uses -1 so the post `(x+1)/2`
    // unit-mapping pins her fused score to 0 — below epsilon.
    stageTurn([
      { slug: "carol-jazz", denseScore: 1.0 },
      { slug: "alice-vscode", denseScore: -1.0 },
    ]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [{ assistantMessage: "", userMessage: "carol" }],
      nowText: "",
      messageId: "msg-1",
      config: makeConfig({ epsilon: 0.05 }),
    });

    const persisted = await hydrate(db, "conv-1");
    expect(persisted!.state["carol-jazz"]).toBeGreaterThan(0.05);
    expect(persisted!.state["alice-vscode"]).toBeUndefined();
  });

  test("returns null block when toInject slugs all reference missing pages", async () => {
    // The ANN response contains a slug that is NOT on disk. After ranking,
    // toInject is non-empty (we don't pre-filter), but `renderInjectionBlock`
    // discovers the page is missing and returns null. The state is still
    // persisted so we don't keep re-attempting.
    stageTurn([{ slug: "phantom-slug", denseScore: 0.99 }]);
    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [{ assistantMessage: "", userMessage: "phantom" }],
      nowText: "",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual(["phantom-slug"]);
    expect(result.block).toBeNull();

    // Activation log marks the slug `page_missing` (not `injected`) so a
    // stale Qdrant / edge-index entry pointing at a vanished page is
    // visible in telemetry instead of masquerading as a successful inject.
    expect(telemetryState.recordCalls.length).toBe(1);
    const row = telemetryState.recordCalls[0] as {
      concepts: Array<{ slug: string; status: string }>;
    };
    const phantom = row.concepts.find((c) => c.slug === "phantom-slug");
    expect(phantom).toBeDefined();
    expect(phantom!.status).toBe("page_missing");
  });

  // ---------------------------------------------------------------------------
  // Unified pool — skills as `skills/<id>` slugs
  // ---------------------------------------------------------------------------

  test("renders a retrieved skills/<id> slug under Skills You Can Use", async () => {
    // No concept-page candidates this turn — the only ANN hit is a skill
    // slug. The render path branches on `skills/` prefix: it pulls the
    // entry from the skill-store cache (mocked) and emits the bullet under
    // the `### Skills You Can Use` subsection.
    stageTurn([{ slug: "skills/retrieved-skill", denseScore: 0.9 }]);
    stageSkills([
      {
        id: "retrieved-skill",
        content:
          'The "Retrieved Skill" skill (retrieved-skill) is available. Helps with retrieved skills.',
      },
    ]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Help me with examples" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual(["skills/retrieved-skill"]);
    expect(result.block).not.toBeNull();
    expect(result.block).not.toContain("<memory>");
    expect(result.block).not.toContain("</memory>");
    expect(result.block).not.toContain("## What I Remember Right Now");
    expect(result.block).not.toContain("# memory/concepts/alice-vscode.md");
    const headerIdx = result.block!.indexOf("### Skills You Can Use");
    const skillIdx = result.block!.indexOf(
      '- The "Retrieved Skill" skill (retrieved-skill) is available. Helps with retrieved skills. → use skill_load to activate',
    );
    expect(headerIdx).toBeGreaterThan(-1);
    expect(skillIdx).toBeGreaterThan(headerIdx);
  });

  test("renders concept-page sections before the skills subsection in mixed blocks", async () => {
    // Concept page hit AND a skill — concept-page sections come first, then
    // the skills subsection.
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.9 },
      { slug: "skills/example-skill-a", denseScore: 0.7 },
    ]);
    stageSkills([
      {
        id: "example-skill-a",
        content:
          'The "Example Skill A" skill (example-skill-a) is available. Helps with examples.',
      },
    ]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Alice's editor" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // Both slugs ranked into top-K and got freshly attached.
    expect(new Set(result.toInject)).toEqual(
      new Set(["alice-vscode", "skills/example-skill-a"]),
    );
    expect(result.block).not.toBeNull();

    const aliceHeaderIdx = result.block!.indexOf(
      "# memory/concepts/alice-vscode.md",
    );
    const skillsIdx = result.block!.indexOf("### Skills You Can Use");
    expect(aliceHeaderIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(aliceHeaderIdx).toBeLessThan(skillsIdx);

    expect(result.block).toContain(
      '- The "Example Skill A" skill (example-skill-a) is available. Helps with examples. → use skill_load to activate',
    );
  });

  test("skills are re-rendered every turn", async () => {
    // Turn 1: skill ranks high, gets attached.
    const skillEntry = {
      id: "example-skill-a",
      content:
        'The "Example Skill A" skill (example-skill-a) is available. Helps with examples.',
    };
    stageTurn([{ slug: "skills/example-skill-a", denseScore: 0.9 }]);
    stageSkills([skillEntry]);
    const result1 = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [{ assistantMessage: "", userMessage: "examples" }],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });
    expect(result1.toInject).toEqual(["skills/example-skill-a"]);
    expect(result1.block).toContain("### Skills You Can Use");

    // Turn 2: same skill ranks top again. It is re-rendered into the block
    // (full top-K every turn — history is stripped, so the turn-1 attachment
    // no longer persists) and reported again in `toInject`.
    stageTurn([{ slug: "skills/example-skill-a", denseScore: 0.9 }]);
    stageSkills([skillEntry]);
    const result2 = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      recentTurnPairs: [
        { assistantMessage: "ok", userMessage: "more examples" },
      ],
      nowText: "Now",
      messageId: "msg-2",
      config: makeConfig(),
    });
    expect(result2.toInject).toEqual(["skills/example-skill-a"]);
    expect(result2.block).not.toBeNull();
    expect(result2.block).toContain("### Skills You Can Use");
  });

  test("skill slugs whose entry is missing from the cache are dropped silently", async () => {
    // The skill ranks into top-K but the in-process cache no longer knows
    // its content (skill uninstalled mid-run, or a startup race where the
    // Qdrant row landed before the skill cache was seeded). The render path
    // drops it without surfacing it as a `missingSlugs` page-missing event —
    // that status is reserved for on-disk concept pages, not catalog-derived
    // skill entries.
    stageTurn([{ slug: "skills/missing-skill", denseScore: 0.9 }]);
    // No `stageSkills` call — cache stays empty.

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [{ assistantMessage: "", userMessage: "anything" }],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // The skill is excluded from `toInject` so the slug isn't reported as
    // injected. `block` collapses to null because the only candidate was a
    // cache miss.
    expect(result.toInject).toEqual([]);
    expect(result.block).toBeNull();
  });

  test("returns null when both concept pages and skills are empty", async () => {
    stageTurn([]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [{ assistantMessage: "", userMessage: "anything" }],
      nowText: "",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual([]);
    expect(result.block).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // CLI-command synthetic entries — same unified-pool plumbing as skills.
  // ---------------------------------------------------------------------------

  test("renders a retrieved cli-commands/<name> slug under CLI Commands You Can Use", async () => {
    stageTurn([{ slug: "cli-commands/attachment", denseScore: 0.9 }]);
    stageCliCommands([
      {
        id: "attachment",
        description: "Manage file attachments for conversations",
        content: 'The "assistant attachment" CLI command is available...',
      },
    ]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "How do I register a video?" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual(["cli-commands/attachment"]);
    expect(result.block).not.toBeNull();
    const headerIdx = result.block!.indexOf("### CLI Commands You Can Use");
    const lineIdx = result.block!.indexOf(
      "- `assistant attachment`: Manage file attachments for conversations",
    );
    expect(headerIdx).toBeGreaterThan(-1);
    expect(lineIdx).toBeGreaterThan(headerIdx);
  });

  test("renders concepts, skills, then cli-commands in that order in mixed blocks", async () => {
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.95 },
      { slug: "skills/example-skill-a", denseScore: 0.85 },
      { slug: "cli-commands/config", denseScore: 0.75 },
    ]);
    stageSkills([
      {
        id: "example-skill-a",
        content:
          'The "Example Skill A" skill (example-skill-a) is available. Helps with examples.',
      },
    ]);
    stageCliCommands([
      {
        id: "config",
        description: "Manage configuration",
        content: 'The "assistant config" CLI command is available...',
      },
    ]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [{ assistantMessage: "", userMessage: "Help me" }],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(new Set(result.toInject)).toEqual(
      new Set([
        "alice-vscode",
        "skills/example-skill-a",
        "cli-commands/config",
      ]),
    );
    const conceptIdx = result.block!.indexOf(
      "# memory/concepts/alice-vscode.md",
    );
    const skillsIdx = result.block!.indexOf("### Skills You Can Use");
    const cliIdx = result.block!.indexOf("### CLI Commands You Can Use");
    expect(conceptIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeGreaterThan(conceptIdx);
    expect(cliIdx).toBeGreaterThan(skillsIdx);
  });

  test("cli-command slugs whose entry is missing from the cache are dropped silently", async () => {
    stageTurn([{ slug: "cli-commands/missing-command", denseScore: 0.9 }]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [{ assistantMessage: "", userMessage: "anything" }],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual([]);
    expect(result.block).toBeNull();
  });

  test("cli-commands are re-rendered every turn", async () => {
    const entry = {
      id: "config",
      description: "Manage configuration",
      content: 'The "assistant config" CLI command is available...',
    };
    stageTurn([{ slug: "cli-commands/config", denseScore: 0.9 }]);
    stageCliCommands([entry]);
    const result1 = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [{ assistantMessage: "", userMessage: "config" }],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });
    expect(result1.toInject).toEqual(["cli-commands/config"]);
    expect(result1.block).toContain("### CLI Commands You Can Use");

    stageTurn([{ slug: "cli-commands/config", denseScore: 0.9 }]);
    stageCliCommands([entry]);
    const result2 = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      recentTurnPairs: [{ assistantMessage: "ok", userMessage: "more config" }],
      nowText: "Now",
      messageId: "msg-2",
      config: makeConfig(),
    });
    // Re-rendered into the block every turn and reported in toInject.
    expect(result2.toInject).toEqual(["cli-commands/config"]);
    expect(result2.block).not.toBeNull();
    expect(result2.block).toContain("### CLI Commands You Can Use");
  });

  test("context-load mode re-renders the full top-K across turns", async () => {
    // Turn 1 (per-turn): seed alice as injected.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Alice's editor" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // Subsequent context-load (post-compaction or fresh load): alice is
    // back in the candidate pool and is re-rendered. We render the full
    // top-K every turn regardless of mode, so context-load behaves like
    // per-turn here.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Reload context" },
      ],
      nowText: "Now",
      messageId: "msg-2",
      mode: "context-load",
      config: makeConfig(),
    });

    expect(result.block).not.toBeNull();
    expect(result.block).toContain("# memory/concepts/alice-vscode.md");
    expect(result.toInject).toEqual(["alice-vscode"]);
  });

  test("context-load mode renders the full top-K on a fresh first turn", async () => {
    // Turn 1 with no prior state and three candidates. This asserts the
    // contract: a fresh first user message gets the entire top-K rendered.
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.9 },
      { slug: "bob-coffee", denseScore: 0.8 },
      { slug: "carol-jazz", denseScore: 0.7 },
    ]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [{ assistantMessage: "", userMessage: "hi" }],
      nowText: "",
      messageId: "msg-1",
      mode: "context-load",
      config: makeConfig({ top_k: 3 }),
    });

    expect(result.block).not.toBeNull();
    expect(result.block).toContain("# memory/concepts/alice-vscode.md");
    expect(result.block).toContain("# memory/concepts/bob-coffee.md");
    expect(result.block).toContain("# memory/concepts/carol-jazz.md");
    // The seeded directed edges (alice→bob, bob→alice, frontmatter-demo→alice)
    // mean alice has two incoming predecessors and bob has one, so directed
    // spread normalizes alice's activation more aggressively than bob's. The
    // resulting rank order is bob > carol (no predecessors) > alice.
    expect(new Set(result.toInject)).toEqual(
      new Set(["alice-vscode", "bob-coffee", "carol-jazz"]),
    );
    expect(result.toInject).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // Activation-log telemetry
  // ---------------------------------------------------------------------------

  test("writes one activation-log row per turn with concept rows partitioned and sorted", async () => {
    // Turn 1: seed alice so turn 2 has a carried-forward candidate.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Alice's editor" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });
    expect(telemetryState.recordCalls.length).toBe(1);

    // Turn 2: alice carries forward and carol is freshly surfaced; both are
    // rendered into the block (full top-K every turn) so both read `injected`.
    // bob would be a candidate only if it carried forward, but with no prior
    // bob entry it doesn't appear here.
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.6 },
      { slug: "carol-jazz", denseScore: 0.95 },
    ]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      recentTurnPairs: [{ assistantMessage: "", userMessage: "Carol's music" }],
      nowText: "Now",
      messageId: "msg-2",
      config: makeConfig(),
    });

    expect(telemetryState.recordCalls.length).toBe(2);
    const row = telemetryState.recordCalls[1] as {
      conversationId: string;
      turn: number;
      mode: string;
      concepts: Array<{
        slug: string;
        finalActivation: number;
        status: string;
        source: string;
      }>;
      config: { top_k: number };
    };
    expect(row.conversationId).toBe("conv-1");
    expect(row.turn).toBe(2);
    expect(row.mode).toBe("per-turn");
    expect(row.config.top_k).toBe(25);

    // The candidate set is the union of fromPrior (alice) and fromAnn
    // (alice + carol) → two concept rows.
    expect(row.concepts.length).toBe(2);
    const slugs = row.concepts.map((c) => c.slug);
    expect(new Set(slugs)).toEqual(new Set(["alice-vscode", "carol-jazz"]));

    // Sorted descending by finalActivation.
    for (let i = 1; i < row.concepts.length; i++) {
      expect(row.concepts[i - 1]!.finalActivation).toBeGreaterThanOrEqual(
        row.concepts[i]!.finalActivation,
      );
    }

    const byslug = new Map(row.concepts.map((c) => [c.slug, c]));
    // Both are rendered into the block on turn 2 (full top-K every turn), so
    // both read `injected` — there is no `in_context` state anymore.
    expect(byslug.get("alice-vscode")!.status).toBe("injected");
    expect(byslug.get("carol-jazz")!.status).toBe("injected");
  });

  test("activation-log concepts include skill rows under the skills/ prefix", async () => {
    // Skills participate in the unified telemetry list — they live in the
    // same `concepts` array, identifiable by the `skills/` slug prefix.
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.9 },
      { slug: "skills/example-skill-a", denseScore: 0.7 },
    ]);
    stageSkills([
      {
        id: "example-skill-a",
        content: "skill content",
      },
    ]);

    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Alice's editor" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(telemetryState.recordCalls.length).toBe(1);
    const row = telemetryState.recordCalls[0] as {
      concepts: Array<{ slug: string; status: string }>;
    };
    const slugs = row.concepts.map((c) => c.slug);
    expect(new Set(slugs)).toEqual(
      new Set(["alice-vscode", "skills/example-skill-a"]),
    );
  });

  test("context-load mode marks every rendered slug as `injected`, never `in_context`", async () => {
    // Turn 1 (per-turn): seed alice so she carries forward into the next
    // turn's candidate pool — the same setup the per-turn telemetry test
    // uses, so the difference between modes is unambiguous.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Alice's editor" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });
    expect(telemetryState.recordCalls.length).toBe(1);

    // Turn 2 in context-load mode (post-compaction or fresh load). Alice
    // carries forward AND ranks high again; carol is a brand-new candidate.
    // Both end up in `topNow` (and therefore in `slugsToRender` since
    // context-load renders the full top-K). The status field must reflect
    // that they were physically rendered into the new user message on this
    // turn — `injected` for both — never the legacy `in_context` status.
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.6 },
      { slug: "carol-jazz", denseScore: 0.95 },
    ]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Reload context" },
      ],
      nowText: "Now",
      messageId: "msg-2",
      mode: "context-load",
      config: makeConfig(),
    });

    expect(telemetryState.recordCalls.length).toBe(2);
    const row = telemetryState.recordCalls[1] as {
      mode: string;
      concepts: Array<{ slug: string; status: string }>;
    };
    expect(row.mode).toBe("context-load");

    const byslug = new Map(row.concepts.map((c) => [c.slug, c]));
    // Both rendered slugs read as `injected` — alice especially, since
    // context-load actually rendered her into the fresh user message on this
    // turn rather than assuming she persists from a prior turn.
    expect(byslug.get("alice-vscode")!.status).toBe("injected");
    expect(byslug.get("carol-jazz")!.status).toBe("injected");

    // No slug reads as `in_context` in context-load mode — the cache was
    // wiped, so there is no prior cached attachment to reference.
    for (const concept of row.concepts) {
      expect(concept.status).not.toBe("in_context");
    }
  });

  test("context-load mode marks candidates outside `slugsToRender` as `not_injected`", async () => {
    // Turn 1 (per-turn): seed both alice and bob with positive activation
    // so they survive into turn 2's prior-state candidate pool.
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.9 },
      { slug: "bob-coffee", denseScore: 0.8 },
    ]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        {
          assistantMessage: "",
          userMessage: "Alice's editor and Bob's coffee",
        },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // Turn 2 (context-load) with `top_k: 1`: alice and bob both carry
    // forward as candidates, but only the top-ranked slug is rendered.
    // Whichever slug doesn't make the cut must read as `not_injected`.
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.95 },
      { slug: "bob-coffee", denseScore: 0.05 },
    ]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Reload context" },
      ],
      nowText: "Now",
      messageId: "msg-2",
      mode: "context-load",
      config: makeConfig({ top_k: 1 }),
    });

    expect(telemetryState.recordCalls.length).toBe(2);
    const row = telemetryState.recordCalls[1] as {
      mode: string;
      concepts: Array<{ slug: string; status: string }>;
    };
    expect(row.mode).toBe("context-load");

    const byslug = new Map(row.concepts.map((c) => [c.slug, c]));
    // Alice ranked first → she is in `slugsToRender` → `injected`.
    expect(byslug.get("alice-vscode")!.status).toBe("injected");
    // Bob was a candidate but didn't make `top_k: 1` → `not_injected`.
    expect(byslug.get("bob-coffee")!.status).toBe("not_injected");
  });

  test("telemetry write failure is non-fatal — injection still returns a normal result", async () => {
    telemetryState.recordShouldThrow = true;

    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Alice's editor" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // No row captured (the throw aborted the push), but the caller still
    // produced a regular block + toInject result.
    expect(telemetryState.recordCalls.length).toBe(0);
    expect(result.toInject).toEqual(["alice-vscode"]);
    expect(result.block).not.toBeNull();
    expect(result.block).toContain("# memory/concepts/alice-vscode.md");
  });

  // ---------------------------------------------------------------------------
  // Per-page error isolation + on-throw telemetry
  // ---------------------------------------------------------------------------

  test("one slug's page-read failing isolates the error — other slugs still render and the corrupt slug records `status: corrupt`", async () => {
    // Two slugs rank into top-K together. Carol's page reads cleanly; alice's
    // `readPage` throws a ZodError mimicking the real "unrecognized
    // frontmatter key" failure that motivated this work. Before the fix, the
    // bare `Promise.all` rejected and the entire turn lost its block AND its
    // activation log row. With per-page isolation, carol still renders and
    // the activation log row marks alice as `corrupt` (telemetry remains
    // observable for triage).
    const zodErr = z.object({ x: z.string() }).safeParse({ x: 1 }).error!;
    pageStoreState.failingSlugs.set("alice-vscode", zodErr);
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.95 },
      { slug: "carol-jazz", denseScore: 0.9 },
    ]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "music and editors" },
      ],
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // (a) Block is non-null and contains content from the OTHER slug; alice
    // is dropped from the rendered block but does not poison the batch.
    expect(result.block).not.toBeNull();
    expect(result.block).toContain("# memory/concepts/carol-jazz.md");
    expect(result.block).not.toContain("# memory/concepts/alice-vscode.md");

    // (b) Activation log row exists with carol `injected` and alice
    // `corrupt`. Status `corrupt` is reserved for read-time throws and is
    // distinct from `page_missing` (which is null-return / file vanished).
    expect(telemetryState.recordCalls.length).toBe(1);
    const row = telemetryState.recordCalls[0] as {
      mode: string;
      concepts: Array<{ slug: string; status: string }>;
    };
    expect(row.mode).toBe("per-turn");
    const byslug = new Map(row.concepts.map((c) => [c.slug, c]));
    expect(byslug.get("alice-vscode")!.status).toBe("corrupt");
    expect(byslug.get("carol-jazz")!.status).toBe("injected");

    // (c) Both slugs land in `toInject` — same handling as `page_missing`
    // (see the phantom-slug test): the slug was attempted this turn and
    // telemetry records the outcome.
    expect(new Set(result.toInject)).toEqual(
      new Set(["alice-vscode", "carol-jazz"]),
    );
  });

  test("a throw before renderInjectionBlock still flushes telemetry as `mode: errored` and re-throws", async () => {
    // The activation-state save throws — the most realistic non-render
    // failure mode (transient SQLite write error mid-injection). The
    // `injectMemoryV2Block` outer try/finally must (a) flush an activation
    // log row tagged `mode: "errored"` so silent failures stay observable
    // in the database, and (b) re-throw so callers (e.g. `prepareMemory`'s
    // outer catch) see the original error and can degrade gracefully.
    activationStoreState.saveShouldThrow = true;
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);

    let threw: unknown = undefined;
    try {
      await injectMemoryV2Block({
        database: db,
        conversationId: "conv-1",
        currentTurn: 1,
        recentTurnPairs: [
          { assistantMessage: "", userMessage: "Alice's editor" },
        ],
        nowText: "Now",
        messageId: "msg-1",
        config: makeConfig(),
      });
    } catch (err) {
      threw = err;
    }

    // The original error propagates to the caller.
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain(
      "simulated activation-store save failure",
    );

    // A telemetry row was still written, tagged `errored`. `concepts` is
    // empty because the throw fired before the row-builder ran — that's
    // expected and documented as part of the contract.
    expect(telemetryState.recordCalls.length).toBe(1);
    const row = telemetryState.recordCalls[0] as {
      mode: string;
      conversationId: string;
      turn: number;
      concepts: unknown[];
    };
    expect(row.mode).toBe("errored");
    expect(row.conversationId).toBe("conv-1");
    expect(row.turn).toBe(1);
    expect(row.concepts).toEqual([]);
  });

  test("activation pipeline routes through `finalizeInjection` — telemetry shape and config snapshot match the contract", async () => {
    // Pure-refactor regression check: `injectMemoryV2Block` now delegates the
    // tail (state save + render + telemetry finalization + log write) to a
    // private `finalizeInjection` helper. This test asserts the helper is
    // exercised by verifying `recordMemoryV2ActivationLog` is called with the
    // same arg shape as before — same conversationId/turn/mode, same config
    // snapshot, and a fully populated concept row whose status was finalized
    // to `"injected"` on the freshly-attached slug.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-finalize",
      currentTurn: 7,
      recentTurnPairs: [
        { assistantMessage: "", userMessage: "Alice's editor" },
      ],
      nowText: "Now",
      messageId: "msg-finalize",
      config: makeConfig(),
    });

    // The helper rendered + persisted just like the original tail did.
    expect(result.block).toContain("alice-vscode");
    expect(result.toInject).toEqual(["alice-vscode"]);

    expect(telemetryState.recordCalls.length).toBe(1);
    const row = telemetryState.recordCalls[0] as {
      conversationId: string;
      turn: number;
      mode: string;
      concepts: Array<{
        slug: string;
        status: string;
        finalActivation: number;
      }>;
      config: {
        d: number;
        c_user: number;
        c_assistant: number;
        c_now: number;
        k: number;
        hops: number;
        top_k: number;
        epsilon: number;
      };
    };
    expect(row.conversationId).toBe("conv-finalize");
    expect(row.turn).toBe(7);
    expect(row.mode).toBe("per-turn");
    // Config snapshot must include all eight tunables — proves the helper is
    // pulling from `config.memory.v2` rather than synthesizing a partial.
    expect(Object.keys(row.config).sort()).toEqual(
      [
        "c_assistant",
        "c_now",
        "c_user",
        "d",
        "epsilon",
        "hops",
        "k",
        "top_k",
      ].sort(),
    );
    // Status finalization ran inside the helper — alice was selected and
    // rendered, so its row reads `injected`.
    const aliceRow = row.concepts.find((c) => c.slug === "alice-vscode");
    expect(aliceRow?.status).toBe("injected");
  });

  // ---------------------------------------------------------------------------
  // Router mode (flag-gated)
  // ---------------------------------------------------------------------------

  describe("router mode", () => {
    test("flag-on: router-selected slugs render and report in toInject", async () => {
      // Router picks alice. The activation pipeline never runs — we don't
      // stage any qdrant responses here, and that's intentional. The
      // candidate set comes straight from the router's `selectedSlugs`.
      routerState.nextResult = {
        selectedSlugs: ["alice-vscode"],
        failureReason: null,
      };

      const result = await injectMemoryV2Block({
        database: db,
        conversationId: "conv-router-1",
        currentTurn: 1,
        recentTurnPairs: [
          { assistantMessage: "", userMessage: "Tell me about Alice" },
        ],
        nowText: "Now",
        messageId: "msg-1",
        config: makeConfig({ router: { enabled: true } }),
      });

      expect(routerState.callCount).toBe(1);
      expect(result.toInject).toEqual(["alice-vscode"]);
      expect(result.block).not.toBeNull();
      expect(result.block).toContain("# memory/concepts/alice-vscode.md");

      const persisted = await hydrate(db, "conv-router-1");
      // Router mode persists an empty sparse activation map — the router
      // does not compute spreading-activation scores.
      expect(persisted!.state).toEqual({});

      // Telemetry: success rows get `mode: "router"` and `source: "router"`,
      // with all activation fields zeroed.
      expect(telemetryState.recordCalls.length).toBe(1);
      const row = telemetryState.recordCalls[0] as {
        mode: string;
        concepts: Array<{
          slug: string;
          source: string;
          status: string;
          finalActivation: number;
          ownActivation: number;
        }>;
      };
      expect(row.mode).toBe("router");
      const aliceRow = row.concepts.find((c) => c.slug === "alice-vscode");
      expect(aliceRow).toBeDefined();
      // Default-stub provenance is `tier3:0` (single-batch path); see the
      // runRouter mock for the synthesis rule.
      expect(aliceRow!.source).toBe("tier3:0");
      expect(aliceRow!.status).toBe("injected");
      expect(aliceRow!.finalActivation).toBe(0);
      expect(aliceRow!.ownActivation).toBe(0);
    });

    test("flag-on: router failure logs warn, writes mode:`errored` telemetry, returns null block", async () => {
      routerState.nextResult = {
        selectedSlugs: [],
        failureReason: "api_error",
      };

      const result = await injectMemoryV2Block({
        database: db,
        conversationId: "conv-router-fail",
        currentTurn: 3,
        recentTurnPairs: [{ assistantMessage: "ok", userMessage: "anything" }],
        nowText: "Now",
        messageId: "msg-fail",
        config: makeConfig({ router: { enabled: true } }),
      });

      expect(result.block).toBeNull();
      expect(result.toInject).toEqual([]);

      // Stub state still advanced.
      const persisted = await hydrate(db, "conv-router-fail");
      expect(persisted).not.toBeNull();
      expect(persisted!.currentTurn).toBe(3);
      expect(persisted!.messageId).toBe("msg-fail");
      expect(persisted!.state).toEqual({});

      // Single telemetry row with `mode: "errored"` (not `"router"`).
      expect(telemetryState.recordCalls.length).toBe(1);
      const row = telemetryState.recordCalls[0] as {
        mode: string;
        conversationId: string;
        turn: number;
        concepts: unknown[];
      };
      expect(row.mode).toBe("errored");
      expect(row.conversationId).toBe("conv-router-fail");
      expect(row.turn).toBe(3);
      expect(row.concepts).toEqual([]);
    });

    test("flag-on: router-failure path swallows a save() error and returns block:null instead of throwing", async () => {
      // PR 30176 refactored router-failure handling to delegate to
      // `finalizeInjection`. That regressed the prior inline log-and-continue
      // semantics on the router-failure path: a transient SQLite write
      // throwing during the stub-state save now aborted the whole turn
      // because `finalizeInjection`'s try/catch re-threw caughtErr at the end.
      //
      // This test stages exactly that scenario — router returns
      // `failureReason: api_error` AND `save()` throws — and asserts the
      // turn completes with `{ block: null, toInject: [] }` rather than
      // propagating the SQLite error to `prepareMemory`.
      routerState.nextResult = {
        selectedSlugs: [],
        failureReason: "api_error",
      };
      activationStoreState.saveShouldThrow = true;

      let threw: unknown = undefined;
      let result: Awaited<ReturnType<typeof injectMemoryV2Block>> | undefined;
      try {
        result = await injectMemoryV2Block({
          database: db,
          conversationId: "conv-router-fail-save-throws",
          currentTurn: 5,
          recentTurnPairs: [
            { assistantMessage: "ok", userMessage: "anything" },
          ],
          nowText: "Now",
          messageId: "msg-fail-save",
          config: makeConfig({ router: { enabled: true } }),
        });
      } catch (err) {
        threw = err;
      }

      expect(threw).toBeUndefined();
      expect(result).toBeDefined();
      expect(result!.block).toBeNull();
      expect(result!.toInject).toEqual([]);

      // Telemetry still flushes with `mode: "errored"` so the failure stays
      // observable — the same row the inline pre-refactor path emitted.
      expect(telemetryState.recordCalls.length).toBe(1);
      const row = telemetryState.recordCalls[0] as {
        mode: string;
        concepts: unknown[];
      };
      expect(row.mode).toBe("errored");
      expect(row.concepts).toEqual([]);
    });

    test("flag-on: router abstention (empty selectedSlugs, no failure) writes mode:`router` row with no injected pages", async () => {
      routerState.nextResult = {
        selectedSlugs: [],
        failureReason: null,
      };

      const result = await injectMemoryV2Block({
        database: db,
        conversationId: "conv-router-abstain",
        currentTurn: 1,
        recentTurnPairs: [{ assistantMessage: "", userMessage: "small talk" }],
        nowText: "Now",
        messageId: "msg-abstain",
        config: makeConfig({ router: { enabled: true } }),
      });

      expect(result.block).toBeNull();
      expect(result.toInject).toEqual([]);

      // Router abstained, so toInject is empty and nothing renders. State
      // still advanced.
      const persisted = await hydrate(db, "conv-router-abstain");
      expect(persisted!.currentTurn).toBe(1);

      // Telemetry: `mode: "router"` row with zero injected pages.
      expect(telemetryState.recordCalls.length).toBe(1);
      const row = telemetryState.recordCalls[0] as {
        mode: string;
        concepts: Array<{ slug: string; status: string }>;
      };
      expect(row.mode).toBe("router");
      const injectedCount = row.concepts.filter(
        (c) => c.status === "injected",
      ).length;
      expect(injectedCount).toBe(0);
    });

    test("flag-on: router-selected slug whose page is missing on disk records `page_missing`", async () => {
      routerState.nextResult = {
        selectedSlugs: ["phantom-router-slug"],
        failureReason: null,
      };

      const result = await injectMemoryV2Block({
        database: db,
        conversationId: "conv-router-missing",
        currentTurn: 1,
        recentTurnPairs: [{ assistantMessage: "", userMessage: "phantom" }],
        nowText: "Now",
        messageId: "msg-missing",
        config: makeConfig({ router: { enabled: true } }),
      });

      // No backing page → block collapses to null.
      expect(result.block).toBeNull();
      // The missing slug still flowed through `slugsToRender`, so it's
      // reported in `toInject` (matching the activation-mode phantom-slug
      // contract); the render simply drops it.
      expect(result.toInject).toEqual(["phantom-router-slug"]);

      // Telemetry: `status: "page_missing"` for the phantom slug.
      expect(telemetryState.recordCalls.length).toBe(1);
      const row = telemetryState.recordCalls[0] as {
        mode: string;
        concepts: Array<{ slug: string; status: string; source: string }>;
      };
      expect(row.mode).toBe("router");
      const phantom = row.concepts.find(
        (c) => c.slug === "phantom-router-slug",
      );
      expect(phantom).toBeDefined();
      expect(phantom!.status).toBe("page_missing");
      expect(phantom!.source).toBe("tier3:0");
    });

    test("flag-on: router re-picking an already-rendered slug re-renders it", async () => {
      // Turn 1: router picks alice. Standard append.
      routerState.nextResult = {
        selectedSlugs: ["alice-vscode"],
        failureReason: null,
      };
      const turn1 = await injectMemoryV2Block({
        database: db,
        conversationId: "conv-router-dedup",
        currentTurn: 1,
        recentTurnPairs: [
          { assistantMessage: "", userMessage: "Tell me about Alice" },
        ],
        nowText: "Now",
        messageId: "msg-1",
        config: makeConfig({ router: { enabled: true } }),
      });
      expect(turn1.toInject).toEqual(["alice-vscode"]);

      // Turn 2: router re-picks alice (still relevant) AND adds bob. Both are
      // rendered into the block — history is stripped every turn, so there is
      // no prior attachment to collide with — and both are reported in
      // `toInject`.
      telemetryState.recordCalls.length = 0;
      routerState.nextResult = {
        selectedSlugs: ["alice-vscode", "bob-coffee"],
        failureReason: null,
      };
      const turn2 = await injectMemoryV2Block({
        database: db,
        conversationId: "conv-router-dedup",
        currentTurn: 2,
        recentTurnPairs: [
          { assistantMessage: "Sure", userMessage: "And Bob?" },
        ],
        nowText: "Now",
        messageId: "msg-2",
        config: makeConfig({ router: { enabled: true } }),
      });

      // Both re-picked alice and freshly-picked bob are rendered and reported.
      expect(turn2.toInject).toEqual(["alice-vscode", "bob-coffee"]);
      expect(turn2.block).not.toBeNull();
      expect(turn2.block).toContain("# memory/concepts/bob-coffee.md");
      expect(turn2.block).toContain("Bob takes his coffee");
      expect(turn2.block).toContain("# memory/concepts/alice-vscode.md");
      expect(turn2.block).toContain("VS Code");
    });

    test("flag-off (default): activation pipeline still runs unchanged", async () => {
      // Regression check — with the router flag explicitly off (the
      // production default), `runRouter` must never be called and the
      // activation pipeline drives the selection just like before.
      stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
      routerState.nextResult = {
        selectedSlugs: ["should-not-be-used"],
        failureReason: null,
      };

      const result = await injectMemoryV2Block({
        database: db,
        conversationId: "conv-flag-off",
        currentTurn: 1,
        recentTurnPairs: [
          { assistantMessage: "", userMessage: "Alice's editor" },
        ],
        nowText: "Now",
        messageId: "msg-1",
        config: makeConfig({ router: { enabled: false } }),
      });

      // Router was not called.
      expect(routerState.callCount).toBe(0);
      // Activation pipeline produced its normal result.
      expect(result.toInject).toEqual(["alice-vscode"]);
      expect(result.block).toContain("# memory/concepts/alice-vscode.md");

      // Telemetry row carries the activation mode, not router.
      expect(telemetryState.recordCalls.length).toBe(1);
      const row = telemetryState.recordCalls[0] as { mode: string };
      expect(row.mode).toBe("per-turn");
    });

    test("flag-on + mode='context-load': router runs and renders its picks", async () => {
      // Context-load is the full top-K bootstrap fired after compaction or
      // a fresh conversation reload. The router runs the same way as on a
      // per-turn injection — it picks the relevant pages and they are
      // rendered. Router abstention here means no v2 pages this turn, which
      // is preferable to letting the activation graph pick something arbitrary.
      routerState.nextResult = {
        selectedSlugs: ["alice-vscode"],
        failureReason: null,
      };

      const result = await injectMemoryV2Block({
        database: db,
        conversationId: "conv-context-load-router-on",
        currentTurn: 1,
        recentTurnPairs: [
          { assistantMessage: "", userMessage: "Tell me about Alice" },
        ],
        nowText: "Now",
        messageId: "msg-1",
        mode: "context-load",
        config: makeConfig({ router: { enabled: true } }),
      });

      // Router was called on context-load too.
      expect(routerState.callCount).toBe(1);

      // Router's picks were rendered.
      expect(result.toInject).toEqual(["alice-vscode"]);
      expect(result.block).toContain("# memory/concepts/alice-vscode.md");

      // Telemetry row reflects the router mode, not the activation mode.
      expect(telemetryState.recordCalls.length).toBe(1);
      const row = telemetryState.recordCalls[0] as { mode: string };
      expect(row.mode).toBe("router");
    });
  });
});
