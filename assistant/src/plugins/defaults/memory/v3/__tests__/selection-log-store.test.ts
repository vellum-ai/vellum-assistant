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
 *   - source/pinned/section mapping and the rendered `<memory>` block;
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

const realFlags = {
  ...(await import("../../../../../config/assistant-feature-flags.js")),
};
const realDb = {
  ...(await import("../../../../../persistence/db-connection.js")),
};
const realPageContent = { ...(await import("../page-content.js")) };

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
  return db;
}

function seed(
  conversationId: string,
  turn: number,
  rows: Array<{
    slug: string;
    source: string;
    pinned?: boolean;
    sectionOrdinal?: number;
    sectionTitle?: string;
  }>,
  messageId: string | null = null,
): void {
  const stmt = memorySqlite.query(
    `INSERT INTO memory_v3_selections
       (conversation_id, turn, slug, source, pinned, created_at,
        message_id, section_ordinal, section_title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      conversationId,
      turn,
      r.slug,
      r.source,
      r.pinned ? 1 : 0,
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

mock.module("../page-content.js", () => ({
  ...realPageContent,
  // The inspector store reconstructs each selection's matched section from the
  // current page; in this unit the test pages don't exist on disk, so the
  // section map is empty and the renderer falls back to the full page. The mock
  // stands in for that render and reflects whether a section was supplied.
  renderV3SectionContent: async (slug: string, section?: { title: string }) =>
    storeMockActive
      ? section
        ? `section[${section.title}] for ${slug}`
        : `body for ${slug}`
      : realPageContent.renderV3SectionContent(slug, undefined),
}));

const {
  getMemoryV3SelectionForInspector,
  getMemoryV3SelectionForInspectorByMessageIds,
  summarizeSelections,
} = await import("../selection-log-store.js");

beforeEach(() => {
  storeMockActive = true;
  liveEnabled = false;
  memoryDbAvailable = true;
  // The inspector's `live` flag comes from `isMemoryV3Live(getConfig())`,
  // which reads `memory.v3.live` — seed it for real.
  setConfig("memory", { v3: { live: false } });
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

  test("maps source/pinned/section and renders the <memory> block", async () => {
    // The second row carries a retired free-text source label (the column is
    // permissive); the inspector passes it through verbatim. Neither row has a
    // matched section, so section fields are null and the block falls back to
    // full pages.
    seed("conv-4", 1, [
      { slug: "domain-a/page-1", source: "edge", pinned: true },
      { slug: "domain-b/page-2", source: "legacy-carry", pinned: false },
    ]);

    const log = await getMemoryV3SelectionForInspector("conv-4", 1);
    expect(log?.selections).toEqual([
      {
        slug: "domain-a/page-1",
        source: "edge",
        pinned: true,
        sectionOrdinal: null,
        sectionHeading: null,
      },
      {
        slug: "domain-b/page-2",
        source: "legacy-carry",
        pinned: false,
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
        pinned: false,
        sectionOrdinal: 2,
        sectionHeading: "Heading A",
      },
      {
        slug: "domain-b/page-2",
        source: "core",
        pinned: false,
        sectionOrdinal: null,
        sectionHeading: null,
      },
    ]);
    expect(log?.injectedText).toContain("<memory>");
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
      { slug: "domain-a/page-1", source: "needle", pinned: true },
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
