/**
 * Tests for `assistant/src/memory/v2/injection.ts`.
 *
 * Coverage matrix:
 *   - Empty state seeds the first injection (initial conversation turn).
 *   - Second turn whose `topNow` overlaps prior `everInjected` returns
 *     `toInject = []` and `block = null` (cache-stable empty path).
 *   - A new topic appearing on a later turn injects only the new slug.
 *   - `evictCompactedTurns` re-enables a previously-injected slug —
 *     after eviction the same slug appears again in `toInject`.
 *   - Unified-pool skills: a `skills/<id>` slug ranked into the top-K is
 *     rendered under `### Skills You Can Use`, mixed concept-page+skill
 *     blocks render concept sections first then the skills suffix, both
 *     empty → null block, skills participate in `everInjected` so they
 *     deduplicate across turns just like concepts.
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
const schema = await import("../../schema.js");
const { evictCompactedTurns, hydrate, save } =
  await import("../activation-store.js");
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
  }> = {},
): AssistantConfig {
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
        ...overrides,
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
  telemetryState.recordCalls.length = 0;
  telemetryState.recordShouldThrow = false;
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
      userMessage: "Tell me about Alice's editor",
      assistantMessage: "",
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

    // State persisted: alice's activation is above epsilon and recorded;
    // everInjected captured the new slug + currentTurn.
    const persisted = await hydrate(db, "conv-1");
    expect(persisted).not.toBeNull();
    expect(persisted!.everInjected).toEqual([
      { slug: "alice-vscode", turn: 1 },
    ]);
    expect(persisted!.state["alice-vscode"]).toBeGreaterThan(0.01);
    expect(persisted!.currentTurn).toBe(1);
    expect(persisted!.messageId).toBe("msg-1");
  });

  test("second turn with overlapping topNow returns null block + empty toInject", async () => {
    // Turn 1 — seed alice as injected.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      userMessage: "Alice's editor",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // Turn 2 — the same slug is still top-of-mind. After subtracting
    // everInjected, toInject is empty → block is null.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      userMessage: "And what about VS Code?",
      assistantMessage: "Alice loves it.",
      nowText: "Now",
      messageId: "msg-2",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual([]);
    expect(result.block).toBeNull();

    // State still advanced (currentTurn moved forward) and the existing
    // everInjected entry is preserved (no duplicate added).
    const persisted = await hydrate(db, "conv-1");
    expect(persisted!.currentTurn).toBe(2);
    expect(persisted!.everInjected).toEqual([
      { slug: "alice-vscode", turn: 1 },
    ]);
    expect(persisted!.messageId).toBe("msg-2");
  });

  test("new topic appears → only the new slug attaches", async () => {
    // Turn 1 — seed alice.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      userMessage: "Editor preferences",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // Turn 2 — carol is now in the candidate pool with high relevance.
    // Both alice (carry-forward) and carol should appear in topNow, but only
    // carol should be in toInject (alice was already attached on turn 1).
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.6 },
      { slug: "carol-jazz", denseScore: 0.95 },
    ]);
    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      userMessage: "Tell me about Carol's music taste",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-2",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual(["carol-jazz"]);
    expect(result.block).toContain("# memory/concepts/carol-jazz.md");
    // The block only shows the new slug — alice's attachment lives on the
    // previous turn's user message.
    expect(result.block).not.toContain("# memory/concepts/alice-vscode.md");

    const persisted = await hydrate(db, "conv-1");
    expect(persisted!.everInjected).toEqual([
      { slug: "alice-vscode", turn: 1 },
      { slug: "carol-jazz", turn: 2 },
    ]);
  });

  test("compaction eviction makes a previously-injected slug eligible again", async () => {
    // Turn 1 — seed alice.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      userMessage: "Alice's editor",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // Simulate compaction: drop all everInjected entries with turn <= 1.
    const beforeEvict = await hydrate(db, "conv-1");
    expect(beforeEvict).not.toBeNull();
    const afterEvict = evictCompactedTurns(beforeEvict!, 1);
    expect(afterEvict.everInjected).toEqual([]);
    await save(db, "conv-1", afterEvict);

    // Turn 2 — alice should now be re-injectable since eviction cleared the
    // everInjected entry. Same simulated relevance as before.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      userMessage: "Alice's editor again",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-2",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual(["alice-vscode"]);
    expect(result.block).toContain("# memory/concepts/alice-vscode.md");

    const persisted = await hydrate(db, "conv-1");
    expect(persisted!.everInjected).toEqual([
      { slug: "alice-vscode", turn: 2 },
    ]);
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
      userMessage: "tell me about the summarized page",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.block).not.toBeNull();
    expect(result.block).toContain(
      "**CRITICAL:** These are page summaries. Read the page file if it looks relevant.",
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
      userMessage: "show me everything",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.block).not.toBeNull();
    // CRITICAL header appears exactly once.
    const criticalCount = (
      result.block!.match(/\*\*CRITICAL:\*\* These are page summaries\./g) ?? []
    ).length;
    expect(criticalCount).toBe(1);
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
      userMessage: "show me the demo",
      assistantMessage: "",
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
      userMessage: "music and editors",
      assistantMessage: "",
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
      userMessage: "carol",
      assistantMessage: "",
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
      userMessage: "phantom",
      assistantMessage: "",
      nowText: "",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual(["phantom-slug"]);
    expect(result.block).toBeNull();

    // everInjected still records the slug so future turns subtract it and
    // we don't infinite-loop on a missing page.
    const persisted = await hydrate(db, "conv-1");
    expect(persisted!.everInjected).toEqual([
      { slug: "phantom-slug", turn: 1 },
    ]);

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

  test("renders a skill-only block via the skills/ slug prefix", async () => {
    // No concept-page candidates this turn — the only ANN hit is a skill
    // slug. The render path branches on `skills/` prefix: it pulls the
    // entry from the skill-store cache (mocked) and emits the bullet under
    // the `### Skills You Can Use` subsection.
    stageTurn([{ slug: "skills/example-skill-a", denseScore: 0.9 }]);
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
      userMessage: "Help me with examples",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual(["skills/example-skill-a"]);
    expect(result.block).not.toBeNull();
    expect(result.block).not.toContain("<memory>");
    expect(result.block).not.toContain("</memory>");
    expect(result.block).not.toContain("## What I Remember Right Now");
    expect(result.block).not.toContain("# memory/concepts/alice-vscode.md");
    expect(result.block).toContain("### Skills You Can Use");
    expect(result.block).toContain(
      '- The "Example Skill A" skill (example-skill-a) is available. Helps with examples. → use skill_load to activate',
    );
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
      userMessage: "Alice's editor",
      assistantMessage: "",
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

  test("skills participate in everInjected — an attached skill is not re-attached on the next turn", async () => {
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
      userMessage: "examples",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });
    expect(result1.toInject).toEqual(["skills/example-skill-a"]);
    expect(result1.block).toContain("### Skills You Can Use");

    // Turn 2: same skill ranks top again. It is already in `everInjected`, so
    // `toInject` is empty and the block is null — the attachment from turn 1
    // remains visible to the agent via the cached prior user message.
    stageTurn([{ slug: "skills/example-skill-a", denseScore: 0.9 }]);
    stageSkills([skillEntry]);
    const result2 = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      userMessage: "more examples",
      assistantMessage: "ok",
      nowText: "Now",
      messageId: "msg-2",
      config: makeConfig(),
    });
    expect(result2.toInject).toEqual([]);
    expect(result2.block).toBeNull();

    const persisted = await hydrate(db, "conv-1");
    expect(persisted!.everInjected).toEqual([
      { slug: "skills/example-skill-a", turn: 1 },
    ]);
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
      userMessage: "anything",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // The skill is excluded from `toInject` (and `everInjected`) so future
    // per-turn runs re-attempt the attach once the cache is populated.
    // `block` collapses to null because the only candidate was a cache miss.
    expect(result.toInject).toEqual([]);
    expect(result.block).toBeNull();

    // Persisted `everInjected` must not record the missing skill — that
    // would block retry on a later turn until compaction-driven eviction.
    const persisted = await hydrate(db, "conv-1");
    expect(persisted!.everInjected).toEqual([]);
  });

  test("returns null when both concept pages and skills are empty", async () => {
    stageTurn([]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      userMessage: "anything",
      assistantMessage: "",
      nowText: "",
      messageId: "msg-1",
      config: makeConfig(),
    });

    expect(result.toInject).toEqual([]);
    expect(result.block).toBeNull();
  });

  test("context-load mode renders topNow even when every slug was previously injected", async () => {
    // Turn 1 (per-turn): seed alice as injected.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      userMessage: "Alice's editor",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // Subsequent context-load (post-compaction or fresh load): alice is
    // back in the candidate pool. Per-turn would dedup against everInjected
    // and produce a null block; context-load must re-render the full top-K
    // because cached attachments don't exist on a fresh load.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      userMessage: "Reload context",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-2",
      mode: "context-load",
      config: makeConfig(),
    });

    expect(result.block).not.toBeNull();
    expect(result.block).toContain("# memory/concepts/alice-vscode.md");
    // No newly-injected slug — alice was already in everInjected.
    expect(result.toInject).toEqual([]);

    // everInjected stays a single entry (alice was already there) — context-
    // load doesn't double-stamp.
    const persisted = await hydrate(db, "conv-1");
    expect(persisted!.everInjected).toEqual([
      { slug: "alice-vscode", turn: 1 },
    ]);
  });

  test("context-load mode renders the full top-K on a fresh first turn", async () => {
    // Turn 1 with no prior state and three candidates. Per-turn and context-
    // load behave identically when everInjected is empty (toInject == topNow),
    // but this asserts the contract: a fresh first user message gets the
    // entire top-K rendered, not just a delta.
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.9 },
      { slug: "bob-coffee", denseScore: 0.8 },
      { slug: "carol-jazz", denseScore: 0.7 },
    ]);

    const result = await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      userMessage: "hi",
      assistantMessage: "",
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

    // All three slugs persisted to everInjected so the next per-turn doesn't
    // re-attach the same content.
    const persisted = await hydrate(db, "conv-1");
    expect(new Set(persisted!.everInjected.map((e) => e.slug))).toEqual(
      new Set(["alice-vscode", "bob-coffee", "carol-jazz"]),
    );
    expect(persisted!.everInjected).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // Activation-log telemetry
  // ---------------------------------------------------------------------------

  test("writes one activation-log row per turn with concept rows partitioned and sorted", async () => {
    // Turn 1: seed alice as injected so turn 2 has an `in_context` candidate.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      userMessage: "Alice's editor",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });
    expect(telemetryState.recordCalls.length).toBe(1);

    // Turn 2: alice carries forward (now `in_context`); carol is freshly
    // surfaced (`injected`); bob would be a candidate only if it carried
    // forward, but with no prior bob entry it doesn't appear here.
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.6 },
      { slug: "carol-jazz", denseScore: 0.95 },
    ]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      userMessage: "Carol's music",
      assistantMessage: "",
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
    // Alice was attached on turn 1 → status `in_context` on turn 2.
    expect(byslug.get("alice-vscode")!.status).toBe("in_context");
    // Carol is freshly injected on turn 2.
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
      userMessage: "Alice's editor",
      assistantMessage: "",
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
    // Turn 1 (per-turn): seed alice as injected so the next turn's prior
    // `everInjected` includes her — the same setup the per-turn telemetry
    // test uses, so the difference between modes is unambiguous.
    stageTurn([{ slug: "alice-vscode", denseScore: 0.9 }]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 1,
      userMessage: "Alice's editor",
      assistantMessage: "",
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
    // turn — `injected` for both — rather than reading `in_context` for
    // alice based on stale prior `everInjected` state.
    stageTurn([
      { slug: "alice-vscode", denseScore: 0.6 },
      { slug: "carol-jazz", denseScore: 0.95 },
    ]);
    await injectMemoryV2Block({
      database: db,
      conversationId: "conv-1",
      currentTurn: 2,
      userMessage: "Reload context",
      assistantMessage: "",
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
    // Both rendered slugs read as `injected` — alice especially, even though
    // she's in prior `everInjected`, because context-load actually rendered
    // her into the fresh user message on this turn.
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
      userMessage: "Alice's editor and Bob's coffee",
      assistantMessage: "",
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
      userMessage: "Reload context",
      assistantMessage: "",
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
      userMessage: "Alice's editor",
      assistantMessage: "",
      nowText: "Now",
      messageId: "msg-1",
      config: makeConfig(),
    });

    // No row captured (the throw aborted the push), but the caller still
    // produced a regular block + toInject result and persisted state.
    expect(telemetryState.recordCalls.length).toBe(0);
    expect(result.toInject).toEqual(["alice-vscode"]);
    expect(result.block).not.toBeNull();
    expect(result.block).toContain("# memory/concepts/alice-vscode.md");

    const persisted = await hydrate(db, "conv-1");
    expect(persisted!.everInjected).toEqual([
      { slug: "alice-vscode", turn: 1 },
    ]);
  });
});
