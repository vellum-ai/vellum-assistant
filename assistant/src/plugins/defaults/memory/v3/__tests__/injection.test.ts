/**
 * Tests for the memory-v3 injection layer (`injector.ts`): frozen net-new
 * cards + ephemeral spotlight.
 *
 *   - net-new dedup: a turn re-selecting already-injected pages renders zero
 *     new cards (empty-text block — still produced, so v2 suppression holds);
 *   - commit deferral: the everInjected-store write happens in the block's
 *     attachment-commit callback (invoked by assembly on user-tail turns),
 *     never in `produce()` itself;
 *   - trust gate: an untrusted remote actor's turn produces nothing and
 *     records nothing (the v2 personal-memory gate);
 *   - fork dedup: a conversation whose everInjected record was seeded from
 *     inherited blocks does not re-render those slugs;
 *   - prune round-trip: a pruned slug that is re-selected re-injects;
 *   - spotlight: current-window entries only, re-rendered (never accumulated),
 *     bounded by `n × (windowTurns + 1)`, live-only, absent from the
 *     persistent card layer.
 *
 * Orchestration is stubbed at the `observeTurn` seam (the injectors' shared
 * input); the everInjected store runs REAL against an in-memory SQLite DB so
 * the dedup contract is exercised end-to-end. `mock.module` is process-global,
 * so every stub delegates to the real implementation unless this file's tests
 * are running (`injectionMockActive`) — mirrors the sibling test files.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateAddMemoryV3Selections } from "../../../../../persistence/migrations/268-add-memory-v3-selections.js";
import { migrateAddMemoryV3EverInjected } from "../../../../../persistence/migrations/277-add-memory-v3-ever-injected.js";
import { migrateMemoryV3SelectionsMessageIdAndSections } from "../../../../../persistence/migrations/283-memory-v3-selections-message-id-and-sections.js";
import * as schema from "../../../../../persistence/schema/index.js";
import type { InjectionBlock } from "../../../../types.js";
import { unwrapMemoryBlock } from "../../memory-marker.js";
import type { OrchestrateResult } from "../orchestrate.js";
import {
  MEMORY_V3_COMMIT_META_KEY,
  type Section,
  type Slug,
} from "../types.js";

const realConfigLoader = {
  ...(await import("../../../../../config/loader.js")),
};
const realMemoryConfig = { ...(await import("../../config.js")) };
const realFlags = {
  ...(await import("../../../../../config/assistant-feature-flags.js")),
};
const realDbConnection = {
  ...(await import("../../../../../persistence/db-connection.js")),
};
const realPageContent = { ...(await import("../page-content.js")) };
const realShadowPlugin = { ...(await import("../shadow-plugin.js")) };

let injectionMockActive = false;

// ─── mutable test state ──────────────────────────────────────────────────────

let liveEnabled = false;
let memoryEnabled = true;
let spotlightConfig = { n: 6, windowTurns: 2 };
/** `null` disables the prune valve (the default for tests not exercising it —
 *  `runPruneValve` bails when the config block is absent). */
let pruneConfig: {
  maxResidentBytes: number;
  targetResidentBytes: number;
} | null = null;
/** Canned orchestrate result per turnIndex; `null` simulates an ordinary miss. */
let turnResults = new Map<number, OrchestrateResult | null | Error>();
const observeTurnSpy = mock(
  async (
    _conversationId: string,
    turnIndex: number,
  ): Promise<OrchestrateResult | null> => {
    const value = turnResults.get(turnIndex) ?? null;
    if (value instanceof Error) throw value;
    return value;
  },
);

const logCalls: Array<{ data: unknown; msg: string }> = [];
mock.module("../../../../../util/logger.js", () => ({
  getLogger: () => ({
    info: (data: unknown, msg: string) => logCalls.push({ data, msg }),
    warn: (data: unknown, msg: string) => logCalls.push({ data, msg }),
    error: () => {},
    debug: () => {},
  }),
}));

let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3EverInjected(db);
  // The prune valve's recency ranking reads `memory_v3_selections`.
  migrateAddMemoryV3Selections(db);
  migrateMemoryV3SelectionsMessageIdAndSections(db);
  // The prune valve plans only against slugs whose card sections are
  // locatable in persisted `memoryV3InjectedBlock` rows
  // (`collectPersistedV3Cards`) — minimal `messages` shape it reads.
  testSqlite.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  return db;
}

mock.module("../../../../../persistence/db-connection.js", () => ({
  ...realDbConnection,
  getDb: () => (injectionMockActive ? testDb : realDbConnection.getDb()),
  getSqliteFrom: (db: unknown) =>
    injectionMockActive
      ? testSqlite
      : realDbConnection.getSqliteFrom(
          db as Parameters<typeof realDbConnection.getSqliteFrom>[0],
        ),
}));

mock.module("../../../../../config/loader.js", () => ({
  ...realConfigLoader,
  getConfig: () =>
    injectionMockActive
      ? {
          memory: {
            enabled: memoryEnabled,
            v3: {
              live: liveEnabled,
              spotlight: spotlightConfig,
              prune: pruneConfig ?? undefined,
            },
          },
        }
      : realConfigLoader.getConfig(),
}));

// Memory code resolves its config through the plugin's own accessor, not
// getConfig(); stub the same conditional slice there.
mock.module("../../config.js", () => ({
  getMemoryConfig: () =>
    injectionMockActive
      ? {
          enabled: memoryEnabled,
          v3: {
            live: liveEnabled,
            spotlight: spotlightConfig,
            prune: pruneConfig ?? undefined,
          },
        }
      : realMemoryConfig.getMemoryConfig(),
}));

// The prune valve resolves the live conversation through the daemon registry
// (dynamically imported). Stub it so the deferred valve never drags the heavy
// daemon module graph into this test process; `undefined` = "conversation not
// live" (the valve skips the live strip).
mock.module("../../../../../daemon/conversation-registry.js", () => ({
  findConversationOrSubagent: () => undefined,
}));

mock.module("../../../../../config/assistant-feature-flags.js", () => ({
  ...realFlags,
  isAssistantFeatureFlagEnabled: (
    key: string,
    config: Parameters<typeof realFlags.isAssistantFeatureFlagEnabled>[1],
  ) => {
    if (!injectionMockActive) {
      return realFlags.isAssistantFeatureFlagEnabled(
        key as Parameters<typeof realFlags.isAssistantFeatureFlagEnabled>[0],
        config,
      );
    }
    return key === "memory-v3-live" ? liveEnabled : false;
  },
}));

mock.module("../page-content.js", () => ({
  ...realPageContent,
  renderV3CardContent: async (slug: Slug) =>
    injectionMockActive
      ? slug === "missing-page"
        ? ""
        : `# memory/concepts/${slug}.md\ncard body for ${slug}`
      : realPageContent.renderV3CardContent(slug),
}));

mock.module("../shadow-plugin.js", () => ({
  ...realShadowPlugin,
  observeTurn: (conversationId: string, turnIndex: number) =>
    injectionMockActive
      ? observeTurnSpy(conversationId, turnIndex)
      : realShadowPlugin.observeTurn(conversationId, turnIndex),
}));

const {
  memoryV3Injector,
  memoryV3SpotlightInjector,
  resetMemoryV3InjectorStateForTests,
} = await import("../injector.js");
const {
  getActiveSlugs,
  getInjected,
  getPrunedSlugs,
  markPruned,
  recordInjected,
} = await import("../ever-injected-store.js");
const { V3_CARDS_INJECTION_HEADER } = await import("../render-injection.js");
const { flushPruneValveForTests } = await import("../prune.js");
const { drainConversationNotices, resetConversationNoticesForTests } =
  await import("../../../../../daemon/conversation-notices.js");
const { MemoryV3RetrievalUnavailableError } = await import("../pool-select.js");

// ─── helpers ────────────────────────────────────────────────────────────────

function section(slug: Slug, title: string, text: string): Section {
  return { article: slug, title, text, ordinal: 1 };
}

/** An orchestrate result selecting `slugs`, with optional finder-matched
 *  sections (slug → section) feeding the spotlight. */
function result(
  slugs: Slug[],
  matched: Array<[Slug, Section]> = [],
): OrchestrateResult {
  return {
    selections: slugs.map((slug) => ({ slug, pinned: false })),
    matchedSections: new Map(matched),
    lanes: {
      core: [],
      hot: [],
      fresh: [],
      finder: matched.map(([slug]) => ({
        slug,
        descriptor: "",
        lane: "needle" as const,
      })),
    },
  };
}

const GUARDIAN_TRUST = {
  sourceChannel: "vellum",
  trustClass: "guardian",
} as const;

/** Invoke the block's attachment-commit callback — simulating runtime
 *  assembly's user-tail commit point, where the everInjected-store write
 *  (and the prune-valve schedule) now happens. */
function commitCardsBlock(block: InjectionBlock | null): void {
  const commit = block?.meta?.[MEMORY_V3_COMMIT_META_KEY];
  if (typeof commit === "function") (commit as () => void)();
}

/** Produce the cards block WITHOUT committing — what assembly observes on a
 *  turn whose tail is not a user message (the block never attaches). */
function produceCardsWithoutCommit(
  conversationId: string,
  turnIndex: number,
  trust: { sourceChannel: string; trustClass: string } = GUARDIAN_TRUST,
) {
  return memoryV3Injector.produce({
    requestId: "req-1",
    conversationId,
    turnIndex,
    trust: trust as never,
  });
}

/** Produce the cards block and commit it (the normal user-tail turn). */
async function produceCards(conversationId: string, turnIndex: number) {
  const block = await produceCardsWithoutCommit(conversationId, turnIndex);
  commitCardsBlock(block);
  return block;
}

/** Persist a produced card block to message metadata, as the conversation
 *  assembly does in production (unwrapped, under `memoryV3InjectedBlock`) —
 *  the prune valve's plan only counts slugs locatable in persisted rows. */
let persistedMessageSeq = 0;
function persistCardBlockMetadata(
  conversationId: string,
  blockText: string,
): void {
  testSqlite
    .query(
      /*sql*/ `
      INSERT INTO messages (id, conversation_id, role, content, metadata, created_at)
      VALUES (?, ?, 'user', '[]', ?, 0)
    `,
    )
    .run(
      `m-${persistedMessageSeq++}`,
      conversationId,
      JSON.stringify({ memoryV3InjectedBlock: unwrapMemoryBlock(blockText) }),
    );
}

function produceSpotlight(
  conversationId: string,
  turnIndex: number,
  trust: { sourceChannel: string; trustClass: string } = GUARDIAN_TRUST,
) {
  return memoryV3SpotlightInjector.produce({
    requestId: "req-1",
    conversationId,
    turnIndex,
    trust: trust as never,
  });
}

beforeEach(async () => {
  // Drain any prune-valve work the previous test's live injection deferred,
  // so it lands against that test's DB instead of bleeding into this one.
  await flushPruneValveForTests();
  injectionMockActive = true;
  liveEnabled = false;
  memoryEnabled = true;
  spotlightConfig = { n: 6, windowTurns: 2 };
  pruneConfig = null;
  turnResults = new Map();
  observeTurnSpy.mockClear();
  logCalls.length = 0;
  testDb = makeDb();
  resetMemoryV3InjectorStateForTests();
  resetConversationNoticesForTests();
});

afterAll(async () => {
  // Deferred valve work must finish while the mocks are still active.
  await flushPruneValveForTests();
  injectionMockActive = false;
});

// ─── frozen net-new cards ───────────────────────────────────────────────────

describe("memoryV3Injector — frozen net-new cards", () => {
  test("global memory disabled → both injectors produce null without orchestration", async () => {
    liveEnabled = true;
    memoryEnabled = false;
    turnResults.set(0, result(["page-a"]));

    expect(await produceCardsWithoutCommit("conv-1", 0)).toBeNull();
    expect(await produceSpotlight("conv-1", 0)).toBeNull();
    expect(observeTurnSpy).not.toHaveBeenCalled();
    expect(getActiveSlugs("conv-1")).toEqual(new Set());
  });

  test("live retrieval failure queues a degraded-memory notice", async () => {
    liveEnabled = true;
    turnResults.set(
      0,
      new MemoryV3RetrievalUnavailableError("selector unavailable"),
    );

    await expect(produceCardsWithoutCommit("conv-1", 0)).resolves.toBeNull();

    expect(drainConversationNotices("conv-1")).toEqual([
      {
        type: "conversation_notice",
        conversationId: "conv-1",
        source: "memory_v3",
        code: "UNKNOWN",
        userMessage:
          "Memory is temporarily unavailable, so this response may not use your saved memories. You can retry in a moment.",
        errorCategory: "memory_v3_degraded",
      },
    ]);
  });

  test("turn 1 renders cards; turn 2 re-selecting the same pages renders ZERO new cards", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a", "page-b"]));
    turnResults.set(1, result(["page-a", "page-b"]));

    const t1 = await produceCards("conv-1", 0);
    expect(t1).not.toBeNull();
    expect(t1!.placement).toBe("after-memory-prefix");
    expect(t1!.text.startsWith("<memory>\n")).toBe(true);
    expect(t1!.text).toContain(V3_CARDS_INJECTION_HEADER);
    expect(t1!.text).toContain("# memory/concepts/page-a.md");
    expect(t1!.text).toContain("# memory/concepts/page-b.md");
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["page-a", "page-b"]));
    // Recorded bytes match the rendered card sizes (non-zero).
    for (const entry of getInjected("conv-1").values()) {
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.prunedAt).toBeNull();
    }

    // All-repeat turn: the block is still PRODUCED (its presence keys v2
    // suppression) but carries no text — no new persistent bytes.
    const t2 = await produceCards("conv-1", 1);
    expect(t2).not.toBeNull();
    expect(t2!.text).toBe("");
  });

  test("a partially-new turn renders only the net-new cards", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-a", "page-c"]));

    await produceCards("conv-1", 0);
    const t2 = await produceCards("conv-1", 1);
    expect(t2!.text).toContain("# memory/concepts/page-c.md");
    expect(t2!.text).not.toContain("# memory/concepts/page-a.md");
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["page-a", "page-c"]));
  });

  test("fork-seeded dedup record suppresses re-rendering inherited slugs", async () => {
    liveEnabled = true;
    // PR 4's fork hooks seed the child's record from inherited metadata
    // blocks; from the injector's perspective that is just pre-existing rows.
    recordInjected("conv-fork", [{ slug: "page-a", bytes: 0 }]);
    turnResults.set(0, result(["page-a", "page-b"]));

    const block = await produceCards("conv-fork", 0);
    expect(block!.text).toContain("# memory/concepts/page-b.md");
    expect(block!.text).not.toContain("# memory/concepts/page-a.md");
  });

  test("a pruned slug that is re-selected re-injects as a fresh card", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-a"]));

    await produceCards("conv-1", 0);
    markPruned("conv-1", ["page-a"], Date.now());
    expect(getActiveSlugs("conv-1")).toEqual(new Set());

    const t2 = await produceCards("conv-1", 1);
    expect(t2!.text).toContain("# memory/concepts/page-a.md");
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["page-a"]));
  });

  test("end-of-turn prune valve: fires deferred after live injection, exempting core/hot lanes", async () => {
    liveEnabled = true;
    // Each stubbed card is ~47 bytes; cap so the second turn tips over and
    // one prune reaches the target.
    pruneConfig = { maxResidentBytes: 60, targetResidentBytes: 50 };
    const t0 = result(["page-a"]);
    t0.lanes.core = ["page-a"]; // page-a is a core-lane member this turn…
    turnResults.set(0, t0);
    turnResults.set(1, result(["page-b"])); // …but not on turn 1's lanes.

    const b0 = await produceCards("conv-1", 0);
    persistCardBlockMetadata("conv-1", b0!.text);
    await flushPruneValveForTests();
    // Turn 0 is within the cap — nothing pruned.
    expect(getPrunedSlugs("conv-1").size).toBe(0);

    const b1 = await produceCards("conv-1", 1);
    persistCardBlockMetadata("conv-1", b1!.text);
    // The valve is DEFERRED: nothing pruned synchronously at produce time.
    expect(getPrunedSlugs("conv-1").size).toBe(0);
    await flushPruneValveForTests();
    // Over the cap, page-a (oldest, and no longer lane-exempt) is pruned.
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["page-a"]));
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["page-b"]));
  });

  test("slugs whose card renders empty are neither attached nor recorded", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["missing-page", "page-a"]));

    const block = await produceCards("conv-1", 0);
    expect(block!.text).toContain("# memory/concepts/page-a.md");
    expect(block!.text).not.toContain("missing-page");
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["page-a"]));
  });

  test("EVERY net-new card rendering empty → null (v2 fallback), not an empty block", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["missing-page"]));

    // An empty-text block would suppress v2 with nothing to show — a
    // memory-less turn. Distinct from the all-repeat case (empty netNew),
    // where the empty block correctly keeps v2 suppressed.
    expect(await produceCards("conv-1", 0)).toBeNull();
    expect(getActiveSlugs("conv-1")).toEqual(new Set());
  });

  test("produce() defers the store write to the commit callback — a never-attached block records nothing", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));

    // A turn whose tail is not a user message: assembly never invokes the
    // commit, so the store must not claim the cards (which would suppress
    // them until compaction despite never reaching history).
    const block = await produceCardsWithoutCommit("conv-1", 0);
    expect(block).not.toBeNull();
    expect(getActiveSlugs("conv-1")).toEqual(new Set());

    // Assembly's user-tail commit point records them.
    commitCardsBlock(block);
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["page-a"]));
  });

  test("untrusted remote actor → both injectors produce null, no orchestration, nothing recorded", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    const untrusted = { sourceChannel: "telegram", trustClass: "unknown" };

    expect(await produceCardsWithoutCommit("conv-1", 0, untrusted)).toBeNull();
    expect(await produceSpotlight("conv-1", 0, untrusted)).toBeNull();
    // The gate runs before orchestration: nothing selected, nothing recorded.
    expect(observeTurnSpy).not.toHaveBeenCalled();
    expect(getActiveSlugs("conv-1")).toEqual(new Set());
  });

  test("capability cards (skills / CLI commands) record ZERO bytes", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["skills/test-skill", "page-a"]));

    const block = await produceCards("conv-1", 0);
    // Both cards attach…
    expect(block!.text).toContain("skills/test-skill");
    expect(block!.text).toContain("# memory/concepts/page-a.md");
    // …but the capability card's bytes are recorded as 0: its `# Skill:`
    // header is invisible to the prune valve's `# memory/concepts/<slug>.md`
    // section grammar, so non-zero bytes could never be freed and would
    // loop-fire the valve.
    const injected = getInjected("conv-1");
    expect(injected.get("skills/test-skill")!.bytes).toBe(0);
    expect(injected.get("page-a")!.bytes).toBeGreaterThan(0);
  });

  test("per-conversation memo LRU: a key refresh evicts nothing; new-key eviction prefers stale entries", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-a"]));
    // Fill the memo to its 256-entry cap.
    for (let i = 0; i < 256; i++) {
      await produceCards(`conv-${i}`, 0);
    }
    // A new turn for a tracked conversation is a key REFRESH — nothing may be
    // evicted for it (the pre-fix code evicted the oldest entry here).
    await produceCards("conv-5", 1);
    observeTurnSpy.mockClear();
    await produceCards("conv-0", 0);
    expect(observeTurnSpy).toHaveBeenCalledTimes(0); // still memoized
    // A genuinely NEW key at the cap evicts the least-recently-set entry
    // (conv-0); the refreshed conv-5 survives.
    await produceCards("conv-new", 0);
    observeTurnSpy.mockClear();
    await produceCards("conv-5", 1);
    expect(observeTurnSpy).toHaveBeenCalledTimes(0); // refreshed → survived
    await produceCards("conv-0", 0);
    expect(observeTurnSpy).toHaveBeenCalledTimes(1); // evicted → re-observed
  });

  test("empty selection → null (fallback to v2), nothing recorded", async () => {
    liveEnabled = true;
    turnResults.set(0, result([]));
    expect(await produceCards("conv-1", 0)).toBeNull();
    expect(getActiveSlugs("conv-1")).toEqual(new Set());
  });

  test("the persistent card block never contains the spotlight wrapper", async () => {
    liveEnabled = true;
    turnResults.set(
      0,
      result(
        ["page-a"],
        [["page-a", section("page-a", "Heading", "section text")]],
      ),
    );
    const block = await produceCards("conv-1", 0);
    expect(block!.text).not.toContain("<memory_spotlight>");
  });

  test("both injectors share ONE orchestration per turn (memoized)", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    await produceCards("conv-1", 0);
    await produceSpotlight("conv-1", 0);
    expect(observeTurnSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── ephemeral spotlight ────────────────────────────────────────────────────

describe("memoryV3SpotlightInjector — ephemeral section spotlight", () => {
  const sectionA = section("page-a", "Alpha", "alpha section text");
  const sectionB = section("page-b", "Beta", "beta section text");
  const sectionC = section("page-c", "Gamma", "gamma section text");

  test("renders selected finder hits' matched sections right after the memory cards", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a", "page-b"], [["page-a", sectionA]]));

    const block = await produceSpotlight("conv-1", 0);
    expect(block).not.toBeNull();
    expect(block!.placement).toBe("after-memory-prefix");
    expect(block!.text.startsWith("<memory_spotlight>\n")).toBe(true);
    expect(block!.text.endsWith("\n</memory_spotlight>")).toBe(true);
    expect(block!.text).toContain(
      "## memory/concepts/page-a.md § Alpha\nalpha section text",
    );
  });

  test("unselected finder hits do not spotlight; top-n bound applies", async () => {
    liveEnabled = true;
    spotlightConfig = { n: 1, windowTurns: 0 };
    turnResults.set(
      0,
      result(
        ["page-a", "page-b"],
        [
          ["page-c", sectionC], // finder hit, NOT selected
          ["page-a", sectionA],
          ["page-b", sectionB], // selected but over the n=1 cut
        ],
      ),
    );
    const block = await produceSpotlight("conv-1", 0);
    expect(block!.text).toContain("page-a.md § Alpha");
    expect(block!.text).not.toContain("page-b.md");
    expect(block!.text).not.toContain("page-c.md");
  });

  test("carries the previous windowTurns turns' entries, ages older ones out, never accumulates", async () => {
    liveEnabled = true;
    spotlightConfig = { n: 6, windowTurns: 1 };
    turnResults.set(0, result(["page-a"], [["page-a", sectionA]]));
    turnResults.set(1, result(["page-b"], [["page-b", sectionB]]));
    turnResults.set(2, result(["page-c"], [["page-c", sectionC]]));

    const t1 = await produceSpotlight("conv-1", 0);
    expect(t1!.text).toContain("Alpha");

    // Turn 1: current (Beta) + previous turn (Alpha).
    const t2 = await produceSpotlight("conv-1", 1);
    expect(t2!.text).toContain("Beta");
    expect(t2!.text).toContain("Alpha");

    // Turn 2: current (Gamma) + turn 1 (Beta); turn 0 (Alpha) aged out.
    const t3 = await produceSpotlight("conv-1", 2);
    expect(t3!.text).toContain("Gamma");
    expect(t3!.text).toContain("Beta");
    expect(t3!.text).not.toContain("Alpha");
  });

  test("re-producing the SAME turn replaces its window entry (no duplication)", async () => {
    liveEnabled = true;
    spotlightConfig = { n: 6, windowTurns: 2 };
    turnResults.set(0, result(["page-a"], [["page-a", sectionA]]));

    await produceSpotlight("conv-1", 0);
    const again = await produceSpotlight("conv-1", 0);
    const occurrences = again!.text.split("page-a.md § Alpha").length - 1;
    expect(occurrences).toBe(1);
  });

  test("window is bounded by n × (windowTurns + 1) entries", async () => {
    liveEnabled = true;
    spotlightConfig = { n: 2, windowTurns: 1 };
    const sections = (turn: number): Array<[Slug, Section]> =>
      ["w", "x", "y", "z"].map((s) => {
        const slug = `page-${s}${turn}`;
        return [slug, section(slug, `T${turn}${s}`, "text")] as [Slug, Section];
      });
    turnResults.set(
      0,
      result(
        sections(0).map(([s]) => s),
        sections(0),
      ),
    );
    turnResults.set(
      1,
      result(
        sections(1).map(([s]) => s),
        sections(1),
      ),
    );

    await produceSpotlight("conv-1", 0);
    const block = await produceSpotlight("conv-1", 1);
    const entryCount = (block!.text.match(/^## memory\/concepts\//gm) ?? [])
      .length;
    expect(entryCount).toBeLessThanOrEqual(2 * (1 + 1));
  });

  test("no matched sections in the window → no block", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    expect(await produceSpotlight("conv-1", 0)).toBeNull();
  });

  test("live off → null", async () => {
    turnResults.set(0, result(["page-a"], [["page-a", sectionA]]));
    expect(await produceSpotlight("conv-1", 0)).toBeNull();
  });
});
