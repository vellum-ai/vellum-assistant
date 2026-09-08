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
 *   - commit deferral: the net-new record happens in the block's
 *     attachment-commit callback (invoked by assembly on user-tail turns),
 *     never in `produce()` itself;
 *   - selection stamping: every selected section carries the turn's time,
 *     the resident ones (capability units included) stamped at
 *     classification ahead of any await, so a queued valve ranks the fresh
 *     recency and an all-empty render still stamps them, and the net-new
 *     ones with their record at commit;
 *   - pointer re-validation: a resident entry the valve tombstones between
 *     classification and the pointer render is dropped from the pointer;
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
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { setConfig } from "../../../../../__tests__/helpers/set-config.js";
import type { Conversation } from "../../../../../daemon/conversation.js";
import * as schema from "../../../../../persistence/schema/index.js";
import type { InjectionBlock } from "../../../../types.js";
import { unwrapMemoryBlock } from "../../memory-marker.js";
import { isCapabilitySlug } from "../capabilities.js";
import type { OrchestrateResult } from "../orchestrate.js";
import { ensureMemoryV3InjectedSectionsSchema } from "../plugin-schema.js";
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
// The section store (the prune valve's candidate set and recency) lives on
// the dedicated memory connection, resolved via `getMemorySqlite`, stubbed to
// a second in-memory DB carrying the store's schema.
let memorySqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  const db = drizzle(testSqlite, { schema });
  memorySqlite = new Database(":memory:");
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
// Conversations whose turn is running: the injector pins their memo against
// LRU eviction by the live conversation's processing flag.
let processingConversations = new Set<string>();
mock.module("../../../../../daemon/conversation-registry.js", () => ({
  findConversationOrSubagent: (conversationId: string) =>
    processingConversations.has(conversationId)
      ? ({ isProcessing: () => true } as unknown as Conversation)
      : undefined,
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
  memoryV3TurnMemoSizeForTests,
  resetMemoryV3InjectorStateForTests,
} = await import("../injector.js");
const {
  clearConversation,
  getActiveSections,
  getInjected,
  getPrunedSections,
  markPruned,
  recordInjected,
  seedEverInjectedFromBlocks,
} = await import("../ever-injected-store.js");
const { V3_INJECTION_HEADER } = await import("../render-injection.js");
const { flushPruneValveForTests, runPruneValve } = await import("../prune.js");
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

/** An orchestrate result selecting `slugs`, with optional selected sections
 *  (slug → section; a slug listed twice selects two of its sections). */
function result(
  slugs: Slug[],
  matched: Array<[Slug, Section]> = [],
): OrchestrateResult {
  return {
    selections: slugs.map((slug) => ({
      slug,
      sections: matched
        .filter(([matchedSlug]) => matchedSlug === slug)
        .map(([, section]) => section),
    })),
    lanes: {
      core: [],
      hot: [],
      fresh: [],
      always: [],
      finder: matched.map(([slug, section]) => ({
        slug,
        section,
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
  processingConversations = new Set();
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
    expect(t1!.text).not.toContain("page-a - Alpha");
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

  test("two sections of one page selected on one turn both inject, and either is resident afterwards", async () => {
    liveEnabled = true;
    turnResults.set(
      0,
      result(
        ["page-a"],
        [
          ["page-a", alpha],
          ["page-a", beta],
        ],
      ),
    );
    turnResults.set(1, result(["page-a"], [["page-a", beta]]));

    const t1 = await produceSections("conv-1", 0);
    expect(t1!.text).toContain(
      "# memory/concepts/page-a.md § Alpha\nalpha section text",
    );
    expect(t1!.text).toContain(
      "# memory/concepts/page-a.md § Beta\nbeta section text",
    );
    // Both sections were selected, so the lead is not the fallback unit.
    expect(t1!.text).not.toContain(leadRender("page-a"));
    expect(activeIds("conv-1")).toEqual(
      new Set(["page-a§Alpha", "page-a§Beta"]),
    );

    // Re-selecting one of them injects nothing and points at it.
    const t2 = await produceSections("conv-1", 1);
    expect(t2!.text).toBe("");
    const pointer = await producePointer("conv-1", 1);
    expect(pointer!.text).toContain("memory/concepts/page-a.md § Beta");
    expect(pointer!.text).not.toContain("§ Alpha");
  });

  test("every selected section carries the turn's time: resident ones (pointer entries and capability units) are stamped at classification, net-new ones with their record at commit", async () => {
    liveEnabled = true;
    const skill = "skills/test-skill";
    turnResults.set(
      0,
      result(
        ["page-a", skill],
        [
          ["page-a", alpha],
          ["page-a", beta],
        ],
      ),
    );
    // Turn 1 re-selects Beta (a pointer entry) and the skill (resident, with
    // no pointer line) beside net-new page-c; Alpha is not selected.
    turnResults.set(1, result(["page-a", "page-c", skill], [["page-a", beta]]));
    const stamps = () =>
      new Map(
        getInjected("conv-1").map((row) => [
          `${row.slug}§${row.key}`,
          row.lastSelectedAt,
        ]),
      );

    try {
      setSystemTime(new Date(1_000_000));
      await produceSections("conv-1", 0);
      expect(stamps()).toEqual(
        new Map([
          ["page-a§Alpha", 1_000_000],
          ["page-a§Beta", 1_000_000],
          [`${skill}§`, 1_000_000],
        ]),
      );

      // The resident stamps land in produce() itself, ahead of the commit,
      // while page-c is not yet recorded.
      setSystemTime(new Date(2_000_000));
      const block = await produceSectionsWithoutCommit("conv-1", 1);
      expect(stamps()).toEqual(
        new Map([
          ["page-a§Alpha", 1_000_000],
          ["page-a§Beta", 2_000_000],
          [`${skill}§`, 2_000_000],
        ]),
      );
      commitSectionsBlock(block);
      expect(stamps()).toEqual(
        new Map([
          ["page-a§Alpha", 1_000_000],
          ["page-a§Beta", 2_000_000],
          ["page-c§", 2_000_000],
          [`${skill}§`, 2_000_000],
        ]),
      );
      // A touched section keeps its record's injected_at.
      expect(
        getInjected("conv-1").find((row) => row.key === "Beta")!.injectedAt,
      ).toBe(1_000_000);
      const pointer = await producePointer("conv-1", 1);
      expect(pointer!.text).toContain("memory/concepts/page-a.md § Beta");
      expect(pointer!.text).not.toContain("test-skill");
    } finally {
      setSystemTime();
    }
  });

  test("a queued valve that runs between classification and the commit ranks a re-selected resident section by this turn's stamp and evicts the stale ones instead", async () => {
    liveEnabled = true;
    // Each stubbed lead is 52 bytes. Turn 0 injects three with the valve
    // unconfigured, then the cap is set below their 156 resident bytes so the
    // next valve run must free two of them.
    turnResults.set(0, result(["page-a", "page-b", "page-d"]));
    turnResults.set(1, result(["page-a", "page-c"]));
    const stamp = (slug: Slug) =>
      getInjected("conv-1").find((row) => row.slug === slug)?.lastSelectedAt;

    try {
      setSystemTime(new Date(1_000_000));
      await produceSections("conv-1", 0);
      await flushPruneValveForTests();
      pruneConfig = { maxResidentBytes: 110, targetResidentBytes: 100 };

      // Turn 1 re-selects page-a beside net-new page-c: page-a is stamped in
      // produce() itself, ahead of the commit.
      setSystemTime(new Date(2_000_000));
      const block = await produceSectionsWithoutCommit("conv-1", 1);
      expect(stamp("page-a")).toBe(2_000_000);
      expect(stamp("page-b")).toBe(1_000_000);
      expect(stamp("page-d")).toBe(1_000_000);

      // The pending valve fires before the commit. On turn 0's stamps alone
      // page-a would be the first to go (the slug tiebreak); this turn's
      // stamp keeps it, and the two stale leads go instead.
      const plan = await runPruneValve("conv-1", { liveMessages: () => null });
      expect(plan?.sections).toEqual([
        { slug: "page-b", key: "" },
        { slug: "page-d", key: "" },
      ]);
      expect(prunedIds("conv-1")).toEqual(new Set(["page-b§", "page-d§"]));

      commitSectionsBlock(block);
      await flushPruneValveForTests();
      expect(activeIds("conv-1")).toEqual(new Set(["page-a§", "page-c§"]));
      const pointer = await producePointer("conv-1", 1);
      expect(pointer!.text).toContain("memory/concepts/page-a.md");
      expect(pointer!.text).not.toContain("page-b");
    } finally {
      setSystemTime();
    }
  });

  test("a resident section selected beside net-new units that all render empty still takes this turn's stamp and is still pointed at", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-a", "missing-page"]));
    const stamp = () =>
      getInjected("conv-1").find((row) => row.slug === "page-a")!
        .lastSelectedAt;

    try {
      setSystemTime(new Date(1_000_000));
      await produceSections("conv-1", 0);
      expect(stamp()).toBe(1_000_000);

      // Every net-new unit renders empty: no block and no commit, but the
      // resident page-a was selected this turn and ages from it.
      setSystemTime(new Date(2_000_000));
      expect(await produceSections("conv-1", 1)).toBeNull();
      expect(stamp()).toBe(2_000_000);
      expect(activeIds("conv-1")).toEqual(new Set(["page-a§"]));
      const pointer = await producePointer("conv-1", 1);
      expect(pointer!.text).toContain("memory/concepts/page-a.md");
    } finally {
      setSystemTime();
    }
  });

  test("a capability page selected on two sections injects its content once", async () => {
    liveEnabled = true;
    // Capability content injects whole under the empty key, so two selected
    // sections of a skill page are one unit.
    const skill = "skills/test-skill";
    turnResults.set(
      0,
      result(
        [skill],
        [
          [skill, section(skill, "Usage", "usage text")],
          [skill, section(skill, "Notes", "notes text")],
        ],
      ),
    );

    const block = await produceSections("conv-1", 0);
    expect(block!.text.split("# Skill: test-skill")).toHaveLength(2);
    expect(activeIds("conv-1")).toEqual(new Set([`${skill}§`]));
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

  test("fork-seeded capability rows suppress re-injecting inherited skill and CLI-command chunks", async () => {
    liveEnabled = true;
    // The fork hooks seed the child's record from the inherited block, which
    // carries capability chunks beside the sections.
    seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-fork",
      [
        {
          inner: [
            V3_INJECTION_HEADER,
            "# Skills\nhint",
            "# Skill: test-skill\nskill body",
            "# CLI command: export\nExport a conversation.",
            leadRender("page-a"),
          ].join("\n\n"),
          format: "current",
        },
      ],
      1_000,
    );
    expect(activeIds("conv-fork")).toEqual(
      new Set(["skills/test-skill§", "cli-commands/export§", "page-a§"]),
    );
    turnResults.set(
      0,
      result(["skills/test-skill", "cli-commands/export", "page-a", "page-b"]),
    );

    const block = await produceSections("conv-fork", 0);
    expect(block!.text).toContain("# memory/concepts/page-b.md");
    expect(block!.text).not.toContain("# Skill:");
    expect(block!.text).not.toContain("# CLI command:");
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

  test("re-entry within the same turn re-emits the first produce's sections and pointer byte for byte, carries no commit, and leaves the store unchanged", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-a", "page-c"], [["page-c", gamma]]));

    try {
      setSystemTime(new Date(1_000_000));
      await produceSections("conv-1", 0);
      const first = await produceSections("conv-1", 1);
      const firstPointer = await producePointer("conv-1", 1);
      expect(first!.text).toContain("§ Gamma");
      expect(firstPointer!.text).toContain("memory/concepts/page-a.md");
      expect(firstPointer!.text).not.toContain("page-c");
      const storeBefore = getInjected("conv-1");

      // Re-entry (the re-injection strip cleared the tail's block and
      // pointer): the same bytes come back. The store counts page-c's section
      // active, so partitioning against it alone would have read it as
      // resident. The clock is stepped so a stray selection stamp on page-a
      // could not tie with the first produce's.
      setSystemTime(new Date(2_000_000));
      const again = await produceSectionsWithoutCommit("conv-1", 1);
      expect(again!.text).toBe(first!.text);
      expect(again!.meta?.[MEMORY_V3_COMMIT_META_KEY]).toBeUndefined();
      expect((await producePointer("conv-1", 1))!.text).toBe(
        firstPointer!.text,
      );
      expect(getInjected("conv-1")).toEqual(storeBefore);
    } finally {
      setSystemTime();
    }
  });

  test("a resident section the valve tombstones between classification and the pointer render is left out of the pointer block", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a", "page-b"]));
    turnResults.set(1, result(["page-a", "page-b", "page-c"]));

    await produceSections("conv-1", 0);
    // Turn 1 classifies page-a and page-b as resident (its pointer entries)
    // beside net-new page-c, and a valve fires before the pointer renders,
    // taking page-a.
    const block = await produceSections("conv-1", 1);
    expect(block!.text).toContain("# memory/concepts/page-c.md");
    markPruned("conv-1", [{ slug: "page-a", key: "" }], Date.now());

    const pointer = await producePointer("conv-1", 1);
    expect(pointer!.text).toContain("\nmemory/concepts/page-b.md\n");
    expect(pointer!.text).not.toContain("page-a");

    // With every remembered entry tombstoned, no pointer is emitted at all.
    markPruned("conv-1", [{ slug: "page-b", key: "" }], Date.now());
    expect(await producePointer("conv-1", 1)).toBeNull();
  });

  test("a re-entry after a compaction's store reset re-emits the first produce's entries, renders the formerly resident pairs anew, and points at nothing", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-a", "page-c"], [["page-c", gamma]]));

    await produceSections("conv-1", 0);
    const first = await produceSections("conv-1", 1);
    expect(first!.text).not.toContain("memory/concepts/page-a.md");
    clearConversation("conv-1");

    const again = await produceSectionsWithoutCommit("conv-1", 1);
    expect(again!.text).toContain("§ Gamma");
    expect(again!.text).toContain("memory/concepts/page-a.md");
    expect(again!.meta?.[MEMORY_V3_COMMIT_META_KEY]).toBeUndefined();
    expect(await producePointer("conv-1", 1)).toBeNull();
    expect(activeIds("conv-1").size).toBe(0);
  });

  test("a turn in flight keeps its memo under LRU pressure, so its re-entry still re-emits the first produce's bytes; an idle conversation's memo is evicted", async () => {
    liveEnabled = true;
    resetMemoryV3InjectorStateForTests(2);
    turnResults.set(0, result(["page-a", "page-c"], [["page-c", gamma]]));
    processingConversations.add("conv-live");
    const first = await produceSections("conv-live", 0);
    expect(first!.text).toContain("§ Gamma");

    // More idle conversations than the cap observe their own turns.
    for (const idle of ["conv-idle-1", "conv-idle-2", "conv-idle-3"]) {
      await produceSections(idle, 0);
    }

    // The live turn's re-entry: memoized, byte-identical, no commit.
    const again = await produceSectionsWithoutCommit("conv-live", 0);
    expect(again!.text).toBe(first!.text);
    expect(again!.meta?.[MEMORY_V3_COMMIT_META_KEY]).toBeUndefined();
    expect(
      observeTurnSpy.mock.calls.filter(([id]) => id === "conv-live"),
    ).toHaveLength(1);

    // The first idle conversation's memo left: its next produce observes
    // the turn again and is a first produce (it carries a commit).
    const idleAgain = await produceSectionsWithoutCommit("conv-idle-1", 0);
    expect(idleAgain!.meta?.[MEMORY_V3_COMMIT_META_KEY]).toBeDefined();
    expect(
      observeTurnSpy.mock.calls.filter(([id]) => id === "conv-idle-1"),
    ).toHaveLength(2);
  });

  test("after a burst of turns in flight past the cap, the next insert shrinks the memo back to capacity", async () => {
    liveEnabled = true;
    resetMemoryV3InjectorStateForTests(2);
    turnResults.set(0, result(["page-a"]));
    const burst = ["conv-b1", "conv-b2", "conv-b3", "conv-b4"];
    for (const id of burst) {
      processingConversations.add(id);
    }
    for (const id of burst) {
      await produceSections(id, 0);
    }
    // Every entry's turn was in flight, so the map grew past the cap.
    expect(memoryV3TurnMemoSizeForTests()).toBe(burst.length);

    // The burst finishes; one more conversation's turn evicts idle entries
    // until the insert fits.
    processingConversations.clear();
    await produceSections("conv-after", 0);
    expect(memoryV3TurnMemoSizeForTests()).toBe(2);
  });

  test("after a burst of turns in flight past the cap, a tracked conversation's next turn (a refresh, not an insert) shrinks the memo back to capacity too", async () => {
    liveEnabled = true;
    resetMemoryV3InjectorStateForTests(2);
    turnResults.set(0, result(["page-a"]));
    turnResults.set(1, result(["page-c"], [["page-c", gamma]]));
    const burst = ["conv-b1", "conv-b2", "conv-b3", "conv-b4"];
    for (const id of burst) {
      processingConversations.add(id);
    }
    for (const id of burst) {
      await produceSections(id, 0);
    }
    expect(memoryV3TurnMemoSizeForTests()).toBe(burst.length);

    // The burst finishes and only an already-tracked conversation stays
    // active: its next turn refreshes its own entry, evicting idle entries
    // until the map fits, and keeps that entry for its own re-entries.
    processingConversations.clear();
    processingConversations.add("conv-b1");
    const first = await produceSections("conv-b1", 1);
    expect(first!.text).toContain("§ Gamma");
    expect(memoryV3TurnMemoSizeForTests()).toBe(2);

    const again = await produceSectionsWithoutCommit("conv-b1", 1);
    expect(again!.text).toBe(first!.text);
    expect(again!.meta?.[MEMORY_V3_COMMIT_META_KEY]).toBeUndefined();
    expect(
      observeTurnSpy.mock.calls.filter(([id]) => id === "conv-b1"),
    ).toHaveLength(2);
  });

  test("a re-entry never revives a section the valve tombstoned since the first produce", async () => {
    liveEnabled = true;
    turnResults.set(
      0,
      result(
        ["page-a", "page-c"],
        [
          ["page-a", alpha],
          ["page-c", gamma],
        ],
      ),
    );

    const first = await produceSections("conv-1", 0);
    expect(first!.text).toContain("§ Alpha");
    markPruned("conv-1", [{ slug: "page-a", key: "Alpha" }], Date.now());

    const again = await produceSectionsWithoutCommit("conv-1", 0);
    expect(again!.text).toContain("§ Gamma");
    expect(again!.text).not.toContain("§ Alpha");
    expect(await producePointer("conv-1", 0)).toBeNull();
    expect(prunedIds("conv-1")).toEqual(new Set(["page-a§Alpha"]));
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

// ─── run-messages replacement ───────────────────────────────────────────────

describe("memoryV3Injector: run-messages replacement (Slack transcript)", () => {
  const alpha = section("page-a", "Alpha", "alpha section text");
  const gamma = section("page-c", "Gamma", "gamma section text");

  /** Produce for an assembly that replaces the run messages with a
   *  transcript rendered from persisted rows, which the chain walker states
   *  on the turn context once the transcript injector has produced it. */
  function produceReplaced(conversationId: string, turnIndex: number) {
    seedMemoryConfig();
    return memoryV3Injector.produce({
      requestId: "req-1",
      conversationId,
      turnIndex,
      trust: GUARDIAN_TRUST as never,
      replacesRunMessages: true,
    });
  }

  function producePointerReplaced(conversationId: string, turnIndex: number) {
    seedMemoryConfig();
    return memoryV3PointerInjector.produce({
      requestId: "req-1",
      conversationId,
      turnIndex,
      trust: GUARDIAN_TRUST as never,
      replacesRunMessages: true,
    });
  }

  test("a resident section renders again with its body, nothing is pointed at, the block carries no commit, and the store is unchanged", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"], [["page-a", alpha]]));
    turnResults.set(
      1,
      result(
        ["page-a", "page-c"],
        [
          ["page-a", alpha],
          ["page-c", gamma],
        ],
      ),
    );

    try {
      // Turn 0 froze Alpha into history and recorded it resident.
      setSystemTime(new Date(1_000_000));
      await produceSections("conv-1", 0);
      expect(activeIds("conv-1")).toEqual(new Set(["page-a§Alpha"]));
      const storeBefore = getInjected("conv-1");

      // Turn 1 is assembled onto a transcript that carries no frozen block,
      // so Alpha's body renders again beside the net-new Gamma. Residency
      // means nothing there, so Alpha takes no selection stamp either (the
      // clock is stepped so a stray one could not tie with turn 0's).
      setSystemTime(new Date(2_000_000));
      const block = await produceReplaced("conv-1", 1);
      expect(block!.text).toContain(
        "# memory/concepts/page-a.md § Alpha\nalpha section text",
      );
      expect(block!.text).toContain(
        "# memory/concepts/page-c.md § Gamma\ngamma section text",
      );
      expect(block!.meta?.[MEMORY_V3_COMMIT_META_KEY]).toBeUndefined();
      expect(await producePointerReplaced("conv-1", 1)).toBeNull();
      expect(getInjected("conv-1")).toEqual(storeBefore);
      expect(activeIds("conv-1")).toEqual(new Set(["page-a§Alpha"]));
    } finally {
      setSystemTime();
    }
  });

  test("a re-entry of a replaced turn re-emits the same bytes and still carries no commit", async () => {
    liveEnabled = true;
    turnResults.set(
      0,
      result(
        ["page-a", "page-c"],
        [
          ["page-a", alpha],
          ["page-c", gamma],
        ],
      ),
    );

    const first = await produceReplaced("conv-1", 0);
    expect(first!.text).toContain("§ Alpha");
    const again = await produceReplaced("conv-1", 0);
    expect(again!.text).toBe(first!.text);
    expect(again!.meta?.[MEMORY_V3_COMMIT_META_KEY]).toBeUndefined();
    expect(observeTurnSpy).toHaveBeenCalledTimes(1);
    expect(activeIds("conv-1")).toEqual(new Set());
  });

  test("the next turn assembled without a replacement records its sections as usual", async () => {
    liveEnabled = true;
    turnResults.set(0, result(["page-a"], [["page-a", alpha]]));
    turnResults.set(1, result(["page-a"], [["page-a", alpha]]));

    await produceReplaced("conv-1", 0);
    expect(activeIds("conv-1")).toEqual(new Set());

    const block = await produceSections("conv-1", 1);
    expect(block!.text).toContain("§ Alpha");
    expect(activeIds("conv-1")).toEqual(new Set(["page-a§Alpha"]));
  });
});
