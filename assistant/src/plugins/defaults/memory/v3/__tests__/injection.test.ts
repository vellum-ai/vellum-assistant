/**
 * Tests for the memory-v3 injection layer (`injector.ts`): frozen net-new
 * sections + per-turn pointer.
 *
 *   - section grain: a page injects its matched section, or its lead when
 *     selected without a match; the same page re-selected with a different
 *     section is net-new, re-selected with the same section is not;
 *   - net-new dedup: a turn re-selecting already-injected sections renders
 *     zero new sections (empty-text block, still produced, so v2 suppression
 *     holds) and lists them in the pointer instead;
 *   - commit deferral: the section-store write happens in the block's
 *     attachment-commit callback (invoked by assembly on user-tail turns),
 *     never in `produce()` itself;
 *   - trust gate: an untrusted remote actor's turn produces nothing and
 *     records nothing (the v2 personal-memory gate);
 *   - fork dedup: a conversation whose record was seeded from inherited
 *     blocks does not re-render those sections;
 *   - prune round-trip: a pruned section that is re-selected re-injects, and
 *     the valve evicts with no lane exemptions;
 *   - pointer: resident re-selections only, paths without bodies, capability
 *     slugs excluded, fixed for the turn across re-entry, live-only.
 *
 * Orchestration is stubbed at the `observeTurn` seam (the injectors' shared
 * input); the section store runs REAL against an in-memory SQLite DB so the
 * dedup contract is exercised end-to-end. `mock.module` is process-global, so
 * every stub delegates to the real implementation unless this file's tests
 * are running (`injectionMockActive`) — mirrors the sibling test files.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { setConfig } from "../../../../../__tests__/helpers/set-config.js";
import { ensureMemoryV3SelectionsSchema } from "../../../../../persistence/migrations/338-move-memory-v3-selections-to-memory-db.js";
import { ensureMemoryV3InjectedSectionsSchema } from "../../../../../persistence/migrations/378-add-memory-v3-injected-sections.js";
import * as schema from "../../../../../persistence/schema/index.js";
import type { InjectionBlock } from "../../../../types.js";
import { unwrapMemoryBlock } from "../../memory-marker.js";
import { isCapabilitySlug } from "../capabilities.js";
import type { OrchestrateResult } from "../orchestrate.js";
import { sectionHeadLine } from "../sections.js";
import {
  MEMORY_V3_COMMIT_META_KEY,
  type Section,
  type Slug,
} from "../types.js";

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
    if (value instanceof Error) {
      throw value;
    }
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
// The prune valve's recency ranking reads `memory_v3_selections` over the
// dedicated memory connection, resolved via `getMemorySqlite` — stubbed to a
// second in-memory DB carrying the relocated tables' schema.
let memorySqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  const db = drizzle(testSqlite, { schema });
  memorySqlite = new Database(":memory:");
  ensureMemoryV3SelectionsSchema(memorySqlite);
  ensureMemoryV3InjectedSectionsSchema(memorySqlite);
  // The prune valve strips only sections locatable in persisted
  // `memoryV3InjectedBlock` rows (`collectPersistedV3Sections`), minimal
  // `messages` shape it reads.
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
  getMemorySqlite: () =>
    injectionMockActive ? memorySqlite : realDbConnection.getMemorySqlite(),
  getMemoryDb: () =>
    injectionMockActive
      ? drizzle(memorySqlite, { schema })
      : realDbConnection.getMemoryDb(),
}));

// The injector reads `memory.enabled` / `memory.v3.live` through the real
// `getConfig()`; the produce helpers seed those for real from the mutable
// knobs below via `seedMemoryConfig()`.

// Memory code resolves its config through the plugin's own accessor, not
// getConfig(); the prune valve reads its bounds there — stub the same
// conditional slice.
mock.module("../../config.js", () => ({
  getMemoryConfig: () =>
    injectionMockActive
      ? {
          enabled: memoryEnabled,
          v3: {
            live: liveEnabled,
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

/** The lead render the entry stub produces for a page (no disk pages here). */
function leadRender(slug: Slug): string {
  return `# memory/concepts/${slug}.md\n# ${slug}\nlead for ${slug}`;
}

mock.module("../page-content.js", () => ({
  ...realPageContent,
  // Pages do not exist on disk in this unit, so the entry renderer is stubbed
  // at the injector's seam: a matched section renders through the REAL
  // section renderer, an unmatched page renders a synthetic lead, a
  // capability slug renders its capability form, and `missing-page` renders
  // nothing (a deleted page).
  renderV3InjectionEntry: async (slug: Slug, section: Section | undefined) => {
    if (!injectionMockActive) {
      return realPageContent.renderV3InjectionEntry(slug, section);
    }
    if (slug === "missing-page") {
      return "";
    }
    if (isCapabilitySlug(slug)) {
      return `# Skill: ${slug.slice("skills/".length)}\nskill body`;
    }
    return section
      ? realPageContent.renderV3SectionInjection(slug, section)
      : leadRender(slug);
  },
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
  memoryV3PointerInjector,
  resetMemoryV3InjectorStateForTests,
} = await import("../injector.js");
const {
  getActiveSections,
  getInjected,
  getPrunedSections,
  markPruned,
  recordInjected,
} = await import("../ever-injected-store.js");
const { V3_INJECTION_HEADER } = await import("../render-injection.js");
const { flushPruneValveForTests } = await import("../prune.js");
const { drainConversationNotices, resetConversationNoticesForTests } =
  await import("../../../../../daemon/conversation-notices.js");
const { MemoryV3RetrievalUnavailableError } = await import("../pool-select.js");

// ─── helpers ────────────────────────────────────────────────────────────────

/** Seed the real config the injector reads (`memory.enabled` / `v3.live`)
 *  from the mutable per-test knobs. Called by the produce helpers just before
 *  invoking the injector so each test's edits take effect. */
function seedMemoryConfig(): void {
  setConfig("memory", {
    enabled: memoryEnabled,
    v3: { live: liveEnabled },
  });
}

/** A heading section as the section index would build it: synthetic head
 *  line plus body. */
function section(slug: Slug, title: string, body: string): Section {
  return {
    article: slug,
    title,
    text: `${sectionHeadLine(slug, title)}\n${body}`,
    ordinal: 1,
  };
}

/** An orchestrate result selecting `slugs`, with optional finder-matched
 *  sections (slug → section). */
function result(
  slugs: Slug[],
  matched: Array<[Slug, Section]> = [],
): OrchestrateResult {
  return {
    selections: slugs.map((slug) => ({ slug })),
    matchedSections: new Map(matched),
    lanes: {
      core: [],
      hot: [],
      fresh: [],
      always: [],
      finder: matched.map(([slug]) => ({
        slug,
        descriptor: "",
        lane: "needle" as const,
      })),
    },
    selectorRan: true,
  };
}

const GUARDIAN_TRUST = {
  sourceChannel: "vellum",
  trustClass: "guardian",
} as const;

/** Invoke the block's attachment-commit callback — simulating runtime
 *  assembly's user-tail commit point, where the section-store write (and the
 *  prune-valve schedule) happens. */
function commitSectionsBlock(block: InjectionBlock | null): void {
  const commit = block?.meta?.[MEMORY_V3_COMMIT_META_KEY];
  if (typeof commit === "function") {
    (commit as () => void)();
  }
}

/** Produce the sections block WITHOUT committing, what assembly observes on
 *  a turn whose tail is not a user message (the block never attaches). */
function produceSectionsWithoutCommit(
  conversationId: string,
  turnIndex: number,
  trust: { sourceChannel: string; trustClass: string } = GUARDIAN_TRUST,
) {
  seedMemoryConfig();
  return memoryV3Injector.produce({
    requestId: "req-1",
    conversationId,
    turnIndex,
    trust: trust as never,
  });
}

/** Produce the sections block and commit it (the normal user-tail turn). */
async function produceSections(conversationId: string, turnIndex: number) {
  const block = await produceSectionsWithoutCommit(conversationId, turnIndex);
  commitSectionsBlock(block);
  return block;
}

/** Persist a produced block to message metadata, as the conversation
 *  assembly does in production (unwrapped, under `memoryV3InjectedBlock`) —
 *  the prune valve's strip only locates sections in persisted rows. */
let persistedMessageSeq = 0;
function persistBlockMetadata(conversationId: string, blockText: string): void {
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

function producePointer(
  conversationId: string,
  turnIndex: number,
  trust: { sourceChannel: string; trustClass: string } = GUARDIAN_TRUST,
) {
  seedMemoryConfig();
  return memoryV3PointerInjector.produce({
    requestId: "req-1",
    conversationId,
    turnIndex,
    trust: trust as never,
  });
}

/** The active set as `slug § key` ids, for terse assertions. */
function activeIds(conversationId: string): Set<string> {
  const ids = new Set<string>();
  for (const [slug, keys] of getActiveSections(conversationId)) {
    for (const key of keys) {
      ids.add(`${slug}§${key}`);
    }
  }
  return ids;
}

function prunedIds(conversationId: string): Set<string> {
  const ids = new Set<string>();
  for (const [slug, keys] of getPrunedSections(conversationId)) {
    for (const key of keys) {
      ids.add(`${slug}§${key}`);
    }
  }
  return ids;
}

beforeEach(async () => {
  // Drain any prune-valve work the previous test's live injection deferred,
  // so it lands against that test's DB instead of bleeding into this one.
  await flushPruneValveForTests();
  injectionMockActive = true;
  liveEnabled = false;
  memoryEnabled = true;
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

// ─── frozen net-new sections ────────────────────────────────────────────────

describe("memoryV3Injector: frozen net-new sections", () => {
  const alpha = section("page-a", "Alpha", "alpha section text");
  const beta = section("page-a", "Beta", "beta section text");

  test("global memory disabled → both injectors produce null without orchestration", async () => {
    liveEnabled = true;
    memoryEnabled = false;
    turnResults.set(0, result(["page-a"]));

    expect(await produceSectionsWithoutCommit("conv-1", 0)).toBeNull();
    expect(await producePointer("conv-1", 0)).toBeNull();
    expect(observeTurnSpy).not.toHaveBeenCalled();
    expect(activeIds("conv-1")).toEqual(new Set());
  });

  test("voice front door skips current-turn orchestration in both injectors", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    seedMemoryConfig();
    const ctx = {
      requestId: "req-voice",
      conversationId: "conv-voice",
      turnIndex: 0,
      trust: GUARDIAN_TRUST,
      callSite: "voiceFrontDoor" as const,
    };

    expect(await memoryV3Injector.produce(ctx)).toBeNull();
    expect(await memoryV3PointerInjector.produce(ctx)).toBeNull();
    expect(observeTurnSpy).not.toHaveBeenCalled();
    expect(activeIds("conv-voice")).toEqual(new Set());
  });

  test("live retrieval failure queues a degraded-memory notice", async () => {
    liveEnabled = true;
    turnResults.set(
      0,
      new MemoryV3RetrievalUnavailableError("selector unavailable"),
    );

    await expect(produceSectionsWithoutCommit("conv-1", 0)).resolves.toBeNull();

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

  test("turn 1 renders matched sections and leads; turn 2 re-selecting the same renders ZERO new sections", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a", "page-b"], [["page-a", alpha]]));
    turnResults.set(1, result(["page-a", "page-b"], [["page-a", alpha]]));

    const t1 = await produceSections("conv-1", 0);
    expect(t1).not.toBeNull();
    expect(t1!.placement).toBe("after-memory-prefix");
    expect(t1!.text.startsWith("<memory>\n")).toBe(true);
    expect(t1!.text).toContain(V3_INJECTION_HEADER);
    // The matched section renders under its `§ key` header without the
    // synthetic head line; the unmatched page renders its lead.
    expect(t1!.text).toContain(
      "# memory/concepts/page-a.md § Alpha\nalpha section text",
    );
    expect(t1!.text).not.toContain("page-a — Alpha");
    expect(t1!.text).toContain(leadRender("page-b"));
    expect(activeIds("conv-1")).toEqual(new Set(["page-a§Alpha", "page-b§"]));
    // Recorded bytes match the rendered sizes (non-zero).
    for (const entry of getInjected("conv-1")) {
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.prunedAt).toBeNull();
    }

    // All-repeat turn: the block is still PRODUCED (its presence keys v2
    // suppression) but carries no text — no new persistent bytes.
    const t2 = await produceSections("conv-1", 1);
    expect(t2).not.toBeNull();
    expect(t2!.text).toBe("");
  });

  test("a partially-new turn renders only the net-new sections", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-a", "page-c"]));

    await produceSections("conv-1", 0);
    const t2 = await produceSections("conv-1", 1);
    expect(t2!.text).toContain("# memory/concepts/page-c.md");
    expect(t2!.text).not.toContain("# memory/concepts/page-a.md");
    expect(activeIds("conv-1")).toEqual(new Set(["page-a§", "page-c§"]));
  });

  test("the same page re-selected with a DIFFERENT matched section injects that section net-new", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"], [["page-a", alpha]]));
    turnResults.set(1, result(["page-a"], [["page-a", beta]]));
    turnResults.set(2, result(["page-a"], [["page-a", alpha]]));

    await produceSections("conv-1", 0);
    const t2 = await produceSections("conv-1", 1);
    expect(t2!.text).toContain("# memory/concepts/page-a.md § Beta");
    expect(t2!.text).not.toContain("§ Alpha");
    expect(activeIds("conv-1")).toEqual(
      new Set(["page-a§Alpha", "page-a§Beta"]),
    );

    // Re-selecting Alpha injects nothing: both sections are resident.
    const t3 = await produceSections("conv-1", 2);
    expect(t3!.text).toBe("");
  });

  test("a page selected without a matched section after a section injection injects its lead once", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"], [["page-a", alpha]]));
    turnResults.set(1, result(["page-a"]));
    turnResults.set(2, result(["page-a"]));

    await produceSections("conv-1", 0);
    const t2 = await produceSections("conv-1", 1);
    expect(t2!.text).toContain(leadRender("page-a"));
    expect(activeIds("conv-1")).toEqual(new Set(["page-a§Alpha", "page-a§"]));
    const t3 = await produceSections("conv-1", 2);
    expect(t3!.text).toBe("");
  });

  test("fork-seeded dedup record suppresses re-rendering inherited sections", async () => {
    liveEnabled = true;
    // The fork hooks seed the child's record from inherited block headers;
    // from the injector's perspective that is just pre-existing rows.
    recordInjected("conv-fork", [{ slug: "page-a", key: "Alpha", bytes: 0 }]);
    turnResults.set(0, result(["page-a", "page-b"], [["page-a", alpha]]));

    const block = await produceSections("conv-fork", 0);
    expect(block!.text).toContain("# memory/concepts/page-b.md");
    expect(block!.text).not.toContain("# memory/concepts/page-a.md");
  });

  test("a pruned section that is re-selected re-injects as a fresh entry", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"], [["page-a", alpha]]));
    turnResults.set(1, result(["page-a"], [["page-a", alpha]]));

    await produceSections("conv-1", 0);
    markPruned("conv-1", [{ slug: "page-a", key: "Alpha" }], Date.now());
    expect(activeIds("conv-1")).toEqual(new Set());

    const t2 = await produceSections("conv-1", 1);
    expect(t2!.text).toContain("# memory/concepts/page-a.md § Alpha");
    expect(activeIds("conv-1")).toEqual(new Set(["page-a§Alpha"]));
  });

  test("end-of-turn prune valve: fires deferred after live injection, with no lane exemptions", async () => {
    liveEnabled = true;
    // Each stubbed lead is 52 bytes; cap so the second turn tips over and
    // one prune reaches the target.
    pruneConfig = { maxResidentBytes: 80, targetResidentBytes: 60 };
    const t0 = result(["page-a"]);
    t0.lanes.core = ["page-a"]; // page-a is a core-lane member…
    turnResults.set(0, t0);
    turnResults.set(1, result(["page-b"]));

    const b0 = await produceSections("conv-1", 0);
    persistBlockMetadata("conv-1", b0!.text);
    await flushPruneValveForTests();
    // Turn 0 is within the cap — nothing pruned.
    expect(prunedIds("conv-1").size).toBe(0);

    const b1 = await produceSections("conv-1", 1);
    persistBlockMetadata("conv-1", b1!.text);
    // The valve is DEFERRED: nothing pruned synchronously at produce time.
    expect(prunedIds("conv-1").size).toBe(0);
    await flushPruneValveForTests();
    // …and over the cap its lead is pruned like any other section: the
    // oldest goes first, core lane or not.
    expect(prunedIds("conv-1")).toEqual(new Set(["page-a§"]));
    expect(activeIds("conv-1")).toEqual(new Set(["page-b§"]));
  });

  test("pages whose entry renders empty are neither attached nor recorded", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["missing-page", "page-a"]));

    const block = await produceSections("conv-1", 0);
    expect(block!.text).toContain("# memory/concepts/page-a.md");
    expect(block!.text).not.toContain("missing-page");
    expect(activeIds("conv-1")).toEqual(new Set(["page-a§"]));
  });

  test("EVERY net-new entry rendering empty → null (v2 fallback), not an empty block", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["missing-page"]));

    // An empty-text block would suppress v2 with nothing to show — a
    // memory-less turn. Distinct from the all-repeat case (empty netNew),
    // where the empty block correctly keeps v2 suppressed.
    expect(await produceSections("conv-1", 0)).toBeNull();
    expect(activeIds("conv-1")).toEqual(new Set());
  });

  test("produce() defers the store write to the commit callback — a never-attached block records nothing", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));

    // A turn whose tail is not a user message: assembly never invokes the
    // commit, so the store must not claim the sections (which would suppress
    // them until compaction despite never reaching history).
    const block = await produceSectionsWithoutCommit("conv-1", 0);
    expect(block).not.toBeNull();
    expect(activeIds("conv-1")).toEqual(new Set());

    // Assembly's user-tail commit point records them.
    commitSectionsBlock(block);
    expect(activeIds("conv-1")).toEqual(new Set(["page-a§"]));
  });

  test("untrusted remote actor → both injectors produce null, no orchestration, nothing recorded", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    const untrusted = { sourceChannel: "telegram", trustClass: "unknown" };

    expect(
      await produceSectionsWithoutCommit("conv-1", 0, untrusted),
    ).toBeNull();
    expect(await producePointer("conv-1", 0, untrusted)).toBeNull();
    // The gate runs before orchestration: nothing selected, nothing recorded.
    expect(observeTurnSpy).not.toHaveBeenCalled();
    expect(activeIds("conv-1")).toEqual(new Set());
  });

  test("capability entries (skills / CLI commands) record ZERO bytes under the empty key", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["skills/test-skill", "page-a"]));

    const block = await produceSections("conv-1", 0);
    // Both entries attach…
    expect(block!.text).toContain("# Skill: test-skill");
    expect(block!.text).toContain("# memory/concepts/page-a.md");
    // …but the capability entry's bytes are recorded as 0: its `# Skill:`
    // header is invisible to the prune valve's section grammar, so non-zero
    // bytes could never be freed and would loop-fire the valve.
    const injected = getInjected("conv-1");
    expect(
      injected.find((row) => row.slug === "skills/test-skill"),
    ).toMatchObject({ key: "", bytes: 0 });
    expect(
      injected.find((row) => row.slug === "page-a")!.bytes,
    ).toBeGreaterThan(0);
  });

  test("per-conversation memo LRU: a key refresh evicts nothing; new-key eviction prefers stale entries", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-a"]));
    // Fill the memo to its 256-entry cap.
    for (let i = 0; i < 256; i++) {
      await produceSections(`conv-${i}`, 0);
    }
    // A new turn for a tracked conversation is a key REFRESH — nothing may be
    // evicted for it.
    await produceSections("conv-5", 1);
    observeTurnSpy.mockClear();
    await produceSections("conv-0", 0);
    expect(observeTurnSpy).toHaveBeenCalledTimes(0); // still memoized
    // A genuinely NEW key at the cap evicts the least-recently-set entry
    // (conv-0); the refreshed conv-5 survives.
    await produceSections("conv-new", 0);
    observeTurnSpy.mockClear();
    await produceSections("conv-5", 1);
    expect(observeTurnSpy).toHaveBeenCalledTimes(0); // refreshed → survived
    await produceSections("conv-0", 0);
    expect(observeTurnSpy).toHaveBeenCalledTimes(1); // evicted → re-observed
  });

  test("empty selection → null (fallback to v2), nothing recorded, no pointer", async () => {
    liveEnabled = true;
    turnResults.set(0, result([]));
    expect(await produceSections("conv-1", 0)).toBeNull();
    expect(await producePointer("conv-1", 0)).toBeNull();
    expect(activeIds("conv-1")).toEqual(new Set());
  });

  test("the persistent block never contains the pointer wrapper", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"], [["page-a", alpha]]));
    const block = await produceSections("conv-1", 0);
    expect(block!.text).not.toContain("<memory_pointer>");
  });

  test("both injectors share ONE orchestration per turn (memoized)", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    await produceSections("conv-1", 0);
    await producePointer("conv-1", 0);
    expect(observeTurnSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── per-turn pointer ───────────────────────────────────────────────────────

describe("memoryV3PointerInjector: ephemeral resident-section pointer", () => {
  const alpha = section("page-a", "Alpha", "alpha section text");
  const beta = section("page-a", "Beta", "beta section text");
  const gamma = section("page-c", "Gamma", "gamma section text");

  test("lists this turn's re-selected resident sections as paths, net-new ones excluded, no bodies", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a", "page-b"], [["page-a", alpha]]));
    turnResults.set(
      1,
      result(
        ["page-a", "page-b", "page-c"],
        [
          ["page-a", alpha],
          ["page-c", gamma],
        ],
      ),
    );

    await produceSections("conv-1", 0);
    // Turn 0: nothing was resident yet → no pointer.
    expect(await producePointer("conv-1", 0)).toBeNull();

    const sections = await produceSections("conv-1", 1);
    expect(sections!.text).toContain("# memory/concepts/page-c.md § Gamma");
    expect(sections!.text).not.toContain("page-a.md");

    const pointer = await producePointer("conv-1", 1);
    expect(pointer).not.toBeNull();
    expect(pointer!.placement).toBe("after-memory-prefix");
    expect(pointer!.text.startsWith("<memory_pointer>\n")).toBe(true);
    expect(pointer!.text.endsWith("\n</memory_pointer>")).toBe(true);
    expect(pointer!.text).toContain("memory/concepts/page-a.md § Alpha");
    expect(pointer!.text).toContain("\nmemory/concepts/page-b.md\n");
    expect(pointer!.text).not.toContain("page-c");
    expect(pointer!.text).not.toContain("alpha section text");
  });

  test("the same page with a different matched section is net-new, not pointed at", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"], [["page-a", alpha]]));
    turnResults.set(1, result(["page-a"], [["page-a", beta]]));

    await produceSections("conv-1", 0);
    const sections = await produceSections("conv-1", 1);
    expect(sections!.text).toContain("§ Beta");
    expect(await producePointer("conv-1", 1)).toBeNull();
  });

  test("capability slugs are never pointed at", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["skills/test-skill", "page-a"]));
    turnResults.set(1, result(["skills/test-skill", "page-a"]));

    await produceSections("conv-1", 0);
    await produceSections("conv-1", 1);
    const pointer = await producePointer("conv-1", 1);
    expect(pointer!.text).toContain("memory/concepts/page-a.md");
    expect(pointer!.text).not.toContain("test-skill");
  });

  test("re-entry within the same turn keeps the first produce's pointer and renders no duplicate sections", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-a", "page-c"], [["page-c", gamma]]));

    await produceSections("conv-1", 0);
    const first = await produceSections("conv-1", 1);
    expect(first!.text).toContain("§ Gamma");

    // Re-entry: everything is now resident, so the sections block is empty,
    // and the pointer must not start pointing at the section this very turn
    // froze onto the tail.
    const again = await produceSections("conv-1", 1);
    expect(again!.text).toBe("");
    const pointer = await producePointer("conv-1", 1);
    expect(pointer!.text).toContain("memory/concepts/page-a.md");
    expect(pointer!.text).not.toContain("page-c");
  });

  test("live off → null even with resident re-selections", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-a"]));
    await produceSections("conv-1", 0);
    await produceSections("conv-1", 1);

    liveEnabled = false;
    expect(await producePointer("conv-1", 1)).toBeNull();
  });
});
