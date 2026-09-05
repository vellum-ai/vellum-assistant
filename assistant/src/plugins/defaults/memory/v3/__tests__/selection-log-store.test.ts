/**
 * Tests for `selection-log-store.ts`.
 *
 * Asserts the inspector read path over `memory_v3_selections`:
 *   - the selection for the exact turn (turn-keyed variant);
 *   - the selection keyed by the turn's message ids (the route's path), which
 *     is robust against v2/v3 turn-counter drift and does not match rows that
 *     predate the message-id backfill;
 *   - null for a null turn, empty message ids, or no matching rows;
 *   - NO blind fallback to a neighbouring turn/message;
 *   - the fork fallback: a turn inherited from a fork resolves to the parent's
 *     rows via the message's `forkSourceMessageId` back-pointer;
 *   - a pool-only turn (a pool row, no selection rows: the selector rejected
 *     everything or the gate hard-skipped) resolves through the pool's
 *     stamped message id, with the same fork walk, to an empty selection
 *     carrying the pool;
 *   - source/section mapping and the rendered `<memory>` block;
 *   - `live` reflects the config gate.
 *
 * `mock.module` is process-global and leaks into sibling files in a
 * `bun test <dir>` run, so every stub DELEGATES to the real implementation
 * unless this test is actively running (`storeMockActive`, toggled in
 * beforeEach/afterAll). Mirrors `shadow-plugin.test.ts`.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { setConfig } from "../../../../../__tests__/helpers/set-config.js";
import { ensureMemoryV3SelectionsSchema } from "../../../../../persistence/migrations/338-move-memory-v3-selections-to-memory-db.js";
import * as schema from "../../../../../persistence/schema/index.js";
import { ensureMemoryV3PoolsSchema } from "../plugin-schema.js";
import type { PoolCandidateRecord, PoolLane } from "../pool-log-store.js";
import { type Section, sectionKey } from "../types.js";

const realFlags = {
  ...(await import("../../../../../config/assistant-feature-flags.js")),
};
const realDb = {
  ...(await import("../../../../../persistence/db-connection.js")),
};
const realPageContent = { ...(await import("../page-content.js")) };
const realPageStore = { ...(await import("../../substrate/page-store.js")) };

let storeMockActive = false;
let liveEnabled = false;
// When false, the stubbed `getMemorySqlite` resolves to null — the contract
// the store sees when the dedicated memory database cannot be opened.
let memoryDbAvailable = true;

let testSqlite: Database;
// Selection rows live on the dedicated memory connection, resolved via
// `getMemorySqlite` — stubbed to a second in-memory DB carrying the relocated
// table's schema. The fork-source fallback still reads `messages` from main.
let memorySqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  testSqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(testSqlite, { schema });
  // The fork-source fallback reads `messages.metadata.forkSourceMessageId`; the
  // inspector store touches only these two columns, so a minimal table suffices.
  testSqlite.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, metadata TEXT)`);
  memorySqlite = new Database(":memory:");
  ensureMemoryV3SelectionsSchema(memorySqlite);
  ensureMemoryV3PoolsSchema(memorySqlite);
  return db;
}

/** One pooled candidate in the persisted shape `writePool` stores. */
function candidate(
  slug: string,
  lane: PoolLane,
  chosen: boolean,
  section?: { title: string; ordinal: number },
): PoolCandidateRecord {
  return {
    slug,
    lane,
    section_title: section?.title ?? null,
    section_ordinal: section?.ordinal ?? null,
    chosen,
  };
}

function seed(
  conversationId: string,
  turn: number,
  rows: Array<{
    slug: string;
    source: string;
    sectionOrdinal?: number;
    sectionTitle?: string;
  }>,
  messageId: string | null = null,
): void {
  const stmt = memorySqlite.query(
    `INSERT INTO memory_v3_selections
       (conversation_id, turn, slug, source, created_at,
        message_id, section_ordinal, section_title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      conversationId,
      turn,
      r.slug,
      r.source,
      1000 + turn,
      messageId,
      r.sectionOrdinal ?? null,
      r.sectionTitle ?? null,
    );
  }
}

function seedMessage(id: string, forkSourceMessageId?: string): void {
  const metadata = JSON.stringify(
    forkSourceMessageId != null ? { forkSourceMessageId } : {},
  );
  testSqlite
    .query(`INSERT INTO messages (id, metadata) VALUES (?, ?)`)
    .run(id, metadata);
}

/** Stamp a pool row with its assistant message id, as the turn-end backfill
 *  does for the pool and selection rows together. */
function stampPool(
  conversationId: string,
  turn: number,
  messageId: string,
): void {
  memorySqlite
    .query(
      `UPDATE memory_v3_pools SET message_id = ?
       WHERE conversation_id = ? AND turn = ?`,
    )
    .run(messageId, conversationId, turn);
}

mock.module("../../../../../config/assistant-feature-flags.js", () => ({
  ...realFlags,
  isAssistantFeatureFlagEnabled: (key: string, config: unknown) =>
    storeMockActive
      ? key === "memory-v3-live"
        ? liveEnabled
        : false
      : realFlags.isAssistantFeatureFlagEnabled(
          key as Parameters<typeof realFlags.isAssistantFeatureFlagEnabled>[0],
          config as Parameters<
            typeof realFlags.isAssistantFeatureFlagEnabled
          >[1],
        ),
}));

mock.module("../../../../../persistence/db-connection.js", () => ({
  ...realDb,
  getDb: () => (storeMockActive ? testDb : realDb.getDb()),
  getSqliteFrom: (db: unknown) =>
    storeMockActive
      ? testSqlite
      : realDb.getSqliteFrom(db as Parameters<typeof realDb.getSqliteFrom>[0]),
  getMemorySqlite: () =>
    storeMockActive
      ? memoryDbAvailable
        ? memorySqlite
        : null
      : realDb.getMemorySqlite(),
}));

// Bodies of the pages the inspector reconstructs matched sections from; a
// slug with no entry reads from disk, where this unit's pages do not exist.
const pageBodies = new Map<string, string>();
mock.module("../../substrate/page-store.js", () => ({
  ...realPageStore,
  readPage: async (workspaceDir: string, slug: string) =>
    storeMockActive && pageBodies.has(slug)
      ? ({ body: pageBodies.get(slug)! } as unknown as Awaited<
          ReturnType<typeof realPageStore.readPage>
        >)
      : realPageStore.readPage(workspaceDir, slug),
}));

mock.module("../page-content.js", () => ({
  ...realPageContent,
  // The inspector store reconstructs each selection's matched section from
  // the current page and renders that section, or the lead when the row
  // resolved to none. The mock stands in for that render and names the
  // section it was handed by key, so a repeat or chunk is told apart.
  renderV3InjectionEntry: async (slug: string, section?: Section) =>
    storeMockActive
      ? section
        ? `# memory/concepts/${slug}.md § ${sectionKey(section)}\nsection[${sectionKey(section)}] for ${slug}`
        : `# memory/concepts/${slug}.md\nbody for ${slug}`
      : realPageContent.renderV3InjectionEntry(slug, undefined),
}));

const {
  getMemoryV3SelectionForInspector,
  getMemoryV3SelectionForInspectorByMessageIds,
  summarizeSelections,
} = await import("../selection-log-store.js");
// The pool writer resolves the same stubbed memory connection, so tests seed
// pool rows through it and read them back through the inspector store.
const { writePool } = await import("../pool-log-store.js");

beforeEach(() => {
  storeMockActive = true;
  liveEnabled = false;
  memoryDbAvailable = true;
  // The inspector's `live` flag comes from `isMemoryV3Live(getConfig())`,
  // which reads `memory.v3.live` — seed it for real.
  setConfig("memory", { v3: { live: false } });
  pageBodies.clear();
  testDb = makeDb();
});

afterAll(() => {
  storeMockActive = false;
});

describe("getMemoryV3SelectionForInspector", () => {
  test("returns null for a null/undefined turn", async () => {
    seed("conv-x", 3, [{ slug: "domain-a/page-1", source: "needle" }]);
    expect(await getMemoryV3SelectionForInspector("conv-x", null)).toBeNull();
    expect(
      await getMemoryV3SelectionForInspector("conv-x", undefined),
    ).toBeNull();
  });

  test("returns the selection for the exact turn", async () => {
    seed("conv-2", 2, [{ slug: "domain-a/page-1", source: "needle" }]);
    seed("conv-2", 7, [{ slug: "domain-b/page-9", source: "needle" }]);

    const log = await getMemoryV3SelectionForInspector("conv-2", 2);
    expect(log?.turn).toBe(2);
    expect(log?.selections.map((s) => s.slug)).toEqual(["domain-a/page-1"]);
  });

  test("returns null when the turn has no v3 rows", async () => {
    seed("conv-1", 3, [{ slug: "domain-a/page-1", source: "needle" }]);
    expect(await getMemoryV3SelectionForInspector("conv-1", 4)).toBeNull();
  });

  test("does NOT fall back to another turn for an unmatched lookup", async () => {
    // Turn 5 has rows, but inspecting turn 3 (no rows) must return null —
    // never turn 5's selection, which would misattribute it to turn 3.
    seed("conv-3", 5, [{ slug: "domain-a/page-1", source: "needle" }]);
    expect(await getMemoryV3SelectionForInspector("conv-3", 3)).toBeNull();
  });

  test("maps source/section and renders the <memory> block", async () => {
    // The second row carries a retired free-text source label (the column is
    // permissive); the inspector passes it through verbatim. Neither row has a
    // matched section, so section fields are null and the block falls back to
    // each page's lead.
    seed("conv-4", 1, [
      { slug: "domain-a/page-1", source: "edge" },
      { slug: "domain-b/page-2", source: "legacy-carry" },
    ]);

    const log = await getMemoryV3SelectionForInspector("conv-4", 1);
    expect(log?.selections).toEqual([
      {
        slug: "domain-a/page-1",
        source: "edge",
        sectionOrdinal: null,
        sectionHeading: null,
      },
      {
        slug: "domain-b/page-2",
        source: "legacy-carry",
        sectionOrdinal: null,
        sectionHeading: null,
      },
    ]);
    expect(log?.injectedText).toContain("<memory>");
    expect(log?.injectedText).toContain("body for domain-a/page-1");
    expect(log?.injectedText).toContain("body for domain-b/page-2");
  });

  test("live reflects the config gate", async () => {
    seed("conv-5", 1, [{ slug: "domain-a/page-1", source: "needle" }]);

    const off = await getMemoryV3SelectionForInspector("conv-5", 1);
    expect(off?.live).toBe(false);

    liveEnabled = true;
    setConfig("memory", { v3: { live: true } });
    const on = await getMemoryV3SelectionForInspector("conv-5", 1);
    expect(on?.live).toBe(true);
  });
});

describe("getMemoryV3SelectionForInspectorByMessageIds", () => {
  test("returns the turn's selection (with section fields) keyed by message id", async () => {
    seed(
      "conv-m",
      0,
      [
        {
          slug: "domain-a/page-1",
          source: "needle",
          sectionOrdinal: 2,
          sectionTitle: "Heading A",
        },
        { slug: "domain-b/page-2", source: "core" },
      ],
      "msg-assistant-1",
    );
    // A different turn under a different message must not bleed in.
    seed(
      "conv-m",
      1,
      [{ slug: "domain-c/page-9", source: "dense" }],
      "msg-assistant-2",
    );

    const log = await getMemoryV3SelectionForInspectorByMessageIds([
      "msg-assistant-1",
    ]);
    expect(log?.turn).toBe(0);
    expect(log?.selections).toEqual([
      {
        slug: "domain-a/page-1",
        source: "needle",
        sectionOrdinal: 2,
        sectionHeading: "Heading A",
      },
      {
        slug: "domain-b/page-2",
        source: "core",
        sectionOrdinal: null,
        sectionHeading: null,
      },
    ]);
    expect(log?.injectedText).toContain("<memory>");
  });

  test("includes the turn's candidate pool when one was persisted", async () => {
    seed(
      "conv-m",
      3,
      [
        { slug: "domain-a/page-1", source: "core" },
        {
          slug: "domain-b/page-2",
          source: "needle",
          sectionOrdinal: 2,
          sectionTitle: "Heading B",
        },
      ],
      "msg-pool",
    );
    // The pool the selector saw: the core card, an unchosen hot card, and the
    // needle line with its matched section. The join is by the selection rows'
    // (conversation, turn), so the pool row needs no message id of its own.
    writePool(memorySqlite, "conv-m", 3, {
      candidates: [
        candidate("domain-a/page-1", "core", true),
        candidate("domain-c/page-9", "hot", false),
        candidate("domain-b/page-2", "needle", true, {
          title: "Heading B",
          ordinal: 2,
        }),
      ],
      pool_size: 3,
      selected_count: 2,
      selector_ran: true,
    });
    // A pool for a neighbouring turn must not bleed in.
    writePool(memorySqlite, "conv-m", 4, {
      candidates: [candidate("other/page", "core", true)],
      pool_size: 1,
      selected_count: 1,
      selector_ran: true,
    });

    const log = await getMemoryV3SelectionForInspectorByMessageIds([
      "msg-pool",
    ]);
    expect(log?.pool).toEqual({
      poolSize: 3,
      selectedCount: 2,
      selectorRan: true,
      candidates: [
        {
          slug: "domain-a/page-1",
          lane: "core",
          sectionHeading: null,
          chosen: true,
        },
        {
          slug: "domain-c/page-9",
          lane: "hot",
          sectionHeading: null,
          chosen: false,
        },
        {
          slug: "domain-b/page-2",
          lane: "needle",
          sectionHeading: "Heading B",
          chosen: true,
        },
      ],
    });
    // The turn-keyed variant resolves the same pool.
    const byTurn = await getMemoryV3SelectionForInspector("conv-m", 3);
    expect(byTurn?.pool).toEqual(log?.pool);
  });

  test("pool is null for a turn logged before pools were persisted", async () => {
    seed("conv-m", 0, [{ slug: "domain-a/page-1", source: "needle" }], "msg-1");
    const log = await getMemoryV3SelectionForInspectorByMessageIds(["msg-1"]);
    expect(log?.selections).toHaveLength(1);
    expect(log?.pool).toBeNull();
  });

  test("resolves the parent's pool for a forked (inherited) turn", async () => {
    seed(
      "conv-parent",
      4,
      [{ slug: "domain-a/page-1", source: "needle" }],
      "parent-msg",
    );
    writePool(memorySqlite, "conv-parent", 4, {
      candidates: [candidate("domain-a/page-1", "needle", true)],
      pool_size: 1,
      selected_count: 1,
      selector_ran: true,
    });
    seedMessage("fork-msg", "parent-msg");

    const log = await getMemoryV3SelectionForInspectorByMessageIds([
      "fork-msg",
    ]);
    expect(log?.pool?.candidates.map((c) => c.slug)).toEqual([
      "domain-a/page-1",
    ]);
  });

  test("a pool-only turn resolves through its stamped message id to an empty selection with the pool", async () => {
    // The selector saw two candidates and rejected both: no selection rows,
    // one pool row, stamped at turn end like the selection rows would be.
    writePool(memorySqlite, "conv-m", 5, {
      candidates: [
        candidate("domain-a/page-1", "core", false),
        candidate("domain-b/page-2", "needle", false, {
          title: "Heading B",
          ordinal: 2,
        }),
      ],
      pool_size: 2,
      selected_count: 0,
      selector_ran: true,
    });
    stampPool("conv-m", 5, "msg-rejected");
    // A selection under another message must not be mistaken for this turn.
    seed("conv-m", 6, [{ slug: "domain-c/page-9", source: "hot" }], "msg-6");

    const log = await getMemoryV3SelectionForInspectorByMessageIds([
      "msg-rejected",
    ]);
    expect(log).toEqual({
      turn: 5,
      live: false,
      selections: [],
      injectedText: "",
      pool: {
        poolSize: 2,
        selectedCount: 0,
        selectorRan: true,
        candidates: [
          {
            slug: "domain-a/page-1",
            lane: "core",
            sectionHeading: null,
            chosen: false,
          },
          {
            slug: "domain-b/page-2",
            lane: "needle",
            sectionHeading: "Heading B",
            chosen: false,
          },
        ],
      },
    });
    // The turn-keyed variant resolves the same pool-only log.
    expect(await getMemoryV3SelectionForInspector("conv-m", 5)).toEqual(log);
  });

  test("a hard-skipped turn resolves to an empty selection whose pool records the selector as not run", async () => {
    writePool(memorySqlite, "conv-m", 5, {
      candidates: [],
      pool_size: 0,
      selected_count: 0,
      selector_ran: false,
    });
    stampPool("conv-m", 5, "msg-skipped");

    const log = await getMemoryV3SelectionForInspectorByMessageIds([
      "msg-skipped",
    ]);
    expect(log?.selections).toEqual([]);
    expect(log?.injectedText).toBe("");
    expect(log?.pool).toEqual({
      poolSize: 0,
      selectedCount: 0,
      selectorRan: false,
      candidates: [],
    });
  });

  test("a fork copy of a pool-only turn resolves through the back-pointer walk", async () => {
    writePool(memorySqlite, "conv-parent", 4, {
      candidates: [candidate("domain-a/page-1", "dense", false)],
      pool_size: 1,
      selected_count: 0,
      selector_ran: true,
    });
    stampPool("conv-parent", 4, "parent-msg");
    // A fork of a fork: neither copy carries rows of its own.
    seedMessage("mid-msg", "parent-msg");
    seedMessage("fork2-msg", "mid-msg");

    const log = await getMemoryV3SelectionForInspectorByMessageIds([
      "fork2-msg",
    ]);
    expect(log?.turn).toBe(4);
    expect(log?.selections).toEqual([]);
    expect(log?.pool?.candidates.map((c) => c.slug)).toEqual([
      "domain-a/page-1",
    ]);
  });

  test("does not match a pool row that predates the message-id backfill (null message_id)", async () => {
    writePool(memorySqlite, "conv-m", 5, {
      candidates: [],
      pool_size: 0,
      selected_count: 0,
      selector_ran: false,
    }); // message_id null
    expect(
      await getMemoryV3SelectionForInspectorByMessageIds(["any"]),
    ).toBeNull();
  });

  test("returns null for empty message ids and for an unmatched id", async () => {
    seed("conv-m", 0, [{ slug: "domain-a/page-1", source: "needle" }], "msg-1");
    expect(await getMemoryV3SelectionForInspectorByMessageIds([])).toBeNull();
    expect(
      await getMemoryV3SelectionForInspectorByMessageIds(["nope"]),
    ).toBeNull();
  });

  test("does not match rows that predate the message-id backfill (null message_id)", async () => {
    seed("conv-m", 0, [{ slug: "domain-a/page-1", source: "needle" }]); // message_id null
    expect(
      await getMemoryV3SelectionForInspectorByMessageIds(["any"]),
    ).toBeNull();
  });

  test("falls back to the parent's selection for a forked (inherited) turn", async () => {
    // The parent logged its selection under the parent assistant message id.
    seed(
      "conv-parent",
      4,
      [{ slug: "domain-a/page-1", source: "needle" }],
      "parent-msg",
    );
    // The fork copied that message under a fresh id with a back-pointer and has
    // no selection rows of its own.
    seedMessage("fork-msg", "parent-msg");

    const log = await getMemoryV3SelectionForInspectorByMessageIds([
      "fork-msg",
    ]);
    expect(log?.selections.map((s) => s.slug)).toEqual(["domain-a/page-1"]);
  });

  test("walks a fork-of-a-fork chain to the original selection", async () => {
    seed(
      "conv-orig",
      2,
      [{ slug: "domain-b/page-2", source: "core" }],
      "orig-msg",
    );
    // The mid fork copied orig; the second fork copied mid. Neither carries its
    // own rows, so resolution must hop twice to reach orig.
    seedMessage("mid-msg", "orig-msg");
    seedMessage("fork2-msg", "mid-msg");

    const log = await getMemoryV3SelectionForInspectorByMessageIds([
      "fork2-msg",
    ]);
    expect(log?.selections.map((s) => s.slug)).toEqual(["domain-b/page-2"]);
  });

  test("prefers the message's own rows over the fork-source fallback", async () => {
    // A post-fork native turn has its own rows AND a back-pointer; the direct
    // rows must win so a native turn is never misattributed to the parent.
    seed("conv-parent", 4, [{ slug: "parent/page", source: "needle" }], "src");
    seed("conv-fork", 0, [{ slug: "own/page", source: "core" }], "native-msg");
    seedMessage("native-msg", "src");

    const log = await getMemoryV3SelectionForInspectorByMessageIds([
      "native-msg",
    ]);
    expect(log?.selections.map((s) => s.slug)).toEqual(["own/page"]);
  });

  test("returns null for a fork copy whose ancestors logged nothing", async () => {
    // A fork copy (has a back-pointer) where neither it nor its source ever
    // logged a v3 selection.
    seedMessage("fork-msg", "parent-msg");
    expect(
      await getMemoryV3SelectionForInspectorByMessageIds(["fork-msg"]),
    ).toBeNull();
  });

  test("returns null when the memory database is unavailable", async () => {
    // Rows exist for both lookup keys, but with the memory connection down
    // both inspector reads (including the fork-fallback walk, which still
    // touches the main-DB `messages` table) must degrade to null, not throw.
    seed(
      "conv-deg",
      1,
      [{ slug: "domain-a/page-1", source: "needle" }],
      "msg-deg",
    );
    memoryDbAvailable = false;
    expect(await getMemoryV3SelectionForInspector("conv-deg", 1)).toBeNull();
    expect(
      await getMemoryV3SelectionForInspectorByMessageIds(["msg-deg"]),
    ).toBeNull();
  });
});

describe("summarizeSelections", () => {
  test("aggregates per-source counts, turn count, and distinct slugs", () => {
    // Turn 1: a needle + an edge selection.
    seed("conv-a", 1, [
      { slug: "domain-a/page-1", source: "needle" },
      { slug: "domain-b/page-2", source: "edge" },
    ]);
    // Turn 2: page-1 re-selected (needle) + page-2 re-surfaced by edge.
    seed("conv-a", 2, [
      { slug: "domain-a/page-1", source: "needle" },
      { slug: "domain-b/page-2", source: "edge" },
    ]);
    // A different conversation must not bleed into the aggregate.
    seed("conv-b", 1, [{ slug: "domain-c/page-9", source: "dense" }]);

    const summary = summarizeSelections("conv-a");
    expect(summary.bySource).toEqual({
      core: 0,
      hot: 0,
      fresh: 0,
      needle: 2,
      dense: 0,
      edge: 2,
      reply: 0,
      span: 0,
      learned: 0,
      entity: 0,
    });
    expect(summary.turns).toBe(2);
    // page-1 and page-2 — distinct across the two turns.
    expect(summary.distinctSlugs).toBe(2);
  });

  test("returns zeroed counts for a conversation with no rows", () => {
    expect(summarizeSelections("conv-none")).toEqual({
      bySource: {
        core: 0,
        hot: 0,
        fresh: 0,
        needle: 0,
        dense: 0,
        edge: 0,
        reply: 0,
        span: 0,
        learned: 0,
        entity: 0,
      },
      turns: 0,
      distinctSlugs: 0,
    });
  });

  test("returns zeroed results when the memory database is unavailable", () => {
    // Rows exist, but with the memory connection down the summary must
    // degrade to zeroes rather than throw.
    seed("conv-deg", 1, [{ slug: "domain-a/page-1", source: "needle" }]);
    memoryDbAvailable = false;
    expect(summarizeSelections("conv-deg")).toEqual({
      bySource: {
        core: 0,
        hot: 0,
        fresh: 0,
        needle: 0,
        dense: 0,
        edge: 0,
        reply: 0,
        span: 0,
        learned: 0,
        entity: 0,
      },
      turns: 0,
      distinctSlugs: 0,
    });
  });

  test("ignores unknown/free-text historical source labels in bySource but counts the turn", () => {
    // A pre-lane historical row with a legacy label (column is free-text) —
    // retired labels like the old per-turn carry source land here too.
    seed("conv-c", 1, [
      { slug: "domain-a/page-1", source: "l1+l2" },
      { slug: "domain-a/page-2", source: "needle" },
    ]);
    const summary = summarizeSelections("conv-c");
    expect(summary.bySource.needle).toBe(1);
    // The unknown label is not counted in any known bucket.
    const total = Object.values(summary.bySource).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
    // But the turn and both distinct slugs are still reflected.
    expect(summary.turns).toBe(1);
    expect(summary.distinctSlugs).toBe(2);
  });
});

describe("matched-section reconstruction", () => {
  const page = [
    "Lead.",
    "",
    "## Heading A",
    "",
    "Body A.",
    "",
    "## Heading B",
    "",
    "Body B.",
  ].join("\n");

  test("a recorded section resolves by its title first, so a page re-chunked since the turn still renders the section that was injected", async () => {
    // At the turn, "Heading A" sat at ordinal 2; the page has since been
    // edited and "Heading B" holds that ordinal.
    pageBodies.set("domain-a/page-1", page);
    seed(
      "conv-r",
      0,
      [
        {
          slug: "domain-a/page-1",
          source: "needle",
          sectionOrdinal: 2,
          sectionTitle: "Heading A",
        },
      ],
      "msg-r-1",
    );

    const log = await getMemoryV3SelectionForInspectorByMessageIds(["msg-r-1"]);
    expect(log?.injectedText).toContain(
      "section[Heading A] for domain-a/page-1",
    );
    expect(log?.injectedText).not.toContain("Heading B");
  });

  test("the ordinal picks among repeats of the title while it still points at one; otherwise the first occurrence", async () => {
    pageBodies.set(
      "domain-a/page-1",
      [
        "Lead.",
        "",
        "## Notes",
        "",
        "First.",
        "",
        "## Notes",
        "",
        "Second.",
      ].join("\n"),
    );
    seed(
      "conv-r",
      0,
      [
        {
          slug: "domain-a/page-1",
          source: "needle",
          sectionOrdinal: 2,
          sectionTitle: "Notes",
        },
      ],
      "msg-r-2",
    );
    seed(
      "conv-r",
      1,
      [
        {
          slug: "domain-a/page-1",
          source: "needle",
          sectionOrdinal: 7,
          sectionTitle: "Notes",
        },
      ],
      "msg-r-3",
    );

    const pointed = await getMemoryV3SelectionForInspectorByMessageIds([
      "msg-r-2",
    ]);
    expect(pointed?.injectedText).toContain(
      "section[Notes#1] for domain-a/page-1",
    );
    const drifted = await getMemoryV3SelectionForInspectorByMessageIds([
      "msg-r-3",
    ]);
    expect(drifted?.injectedText).toContain(
      "section[Notes] for domain-a/page-1",
    );
    expect(drifted?.injectedText).not.toContain("Notes#1");
  });

  test("a title no longer on the page renders the lead; a row recorded without a title falls back to its ordinal", async () => {
    pageBodies.set("domain-a/page-1", page);
    seed(
      "conv-r",
      0,
      [
        {
          slug: "domain-a/page-1",
          source: "needle",
          sectionOrdinal: 1,
          sectionTitle: "Gone",
        },
      ],
      "msg-r-4",
    );
    seed(
      "conv-r",
      1,
      [{ slug: "domain-a/page-1", source: "needle", sectionOrdinal: 1 }],
      "msg-r-5",
    );

    const gone = await getMemoryV3SelectionForInspectorByMessageIds([
      "msg-r-4",
    ]);
    expect(gone?.injectedText).toContain("body for domain-a/page-1");
    expect(gone?.injectedText).not.toContain("section[");
    const untitled = await getMemoryV3SelectionForInspectorByMessageIds([
      "msg-r-5",
    ]);
    expect(untitled?.injectedText).toContain(
      "section[Heading A] for domain-a/page-1",
    );
  });
});
