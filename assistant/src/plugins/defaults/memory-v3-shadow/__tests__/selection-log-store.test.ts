/**
 * Tests for `selection-log-store.ts`.
 *
 * Asserts the inspector read path over `memory_v3_selections`:
 *   - the selection for the exact turn (turn-keyed variant);
 *   - the selection keyed by the turn's message ids (the route's path), which
 *     is robust against v2/v3 turn-counter drift and does not match rows that
 *     predate the message-id backfill;
 *   - null for a null turn, empty message ids, or no matching rows;
 *   - NO fallback to another turn/message;
 *   - source/pinned/section mapping and the rendered `<memory>` block;
 *   - `live` / `shadow` reflect the flag resolver.
 *
 * `mock.module` is process-global and leaks into sibling files in a
 * `bun test <dir>` run, so every stub DELEGATES to the real implementation
 * unless this test is actively running (`storeMockActive`, toggled in
 * beforeEach/afterAll). Mirrors `shadow-plugin.test.ts`.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateAddMemoryV3Selections } from "../../../../memory/migrations/268-add-memory-v3-selections.js";
import { migrateMemoryV3SelectionsMessageIdAndSections } from "../../../../memory/migrations/283-memory-v3-selections-message-id-and-sections.js";
import * as schema from "../../../../memory/schema.js";

const realFlags = {
  ...(await import("../../../../config/assistant-feature-flags.js")),
};
const realLoader = { ...(await import("../../../../config/loader.js")) };
const realDb = { ...(await import("../../../../memory/db-connection.js")) };
const realPageContent = { ...(await import("../page-content.js")) };

let storeMockActive = false;
let liveEnabled = false;
let shadowEnabled = false;

let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  testSqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3Selections(db);
  migrateMemoryV3SelectionsMessageIdAndSections(db);
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
  const stmt = testSqlite.query(
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

mock.module("../../../../config/assistant-feature-flags.js", () => ({
  ...realFlags,
  isAssistantFeatureFlagEnabled: (key: string, config: unknown) =>
    storeMockActive
      ? key === "memory-v3-live"
        ? liveEnabled
        : key === "memory-v3-shadow"
          ? shadowEnabled
          : false
      : realFlags.isAssistantFeatureFlagEnabled(
          key as Parameters<typeof realFlags.isAssistantFeatureFlagEnabled>[0],
          config as Parameters<
            typeof realFlags.isAssistantFeatureFlagEnabled
          >[1],
        ),
}));

mock.module("../../../../config/loader.js", () => ({
  ...realLoader,
  getConfig: () => (storeMockActive ? {} : realLoader.getConfig()),
}));

mock.module("../../../../memory/db-connection.js", () => ({
  ...realDb,
  getDb: () => (storeMockActive ? testDb : realDb.getDb()),
  getSqliteFrom: (db: unknown) =>
    storeMockActive
      ? testSqlite
      : realDb.getSqliteFrom(db as Parameters<typeof realDb.getSqliteFrom>[0]),
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
  shadowEnabled = false;
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

  test("live/shadow reflect the flag resolver", async () => {
    seed("conv-5", 1, [{ slug: "domain-a/page-1", source: "needle" }]);

    const off = await getMemoryV3SelectionForInspector("conv-5", 1);
    expect(off?.live).toBe(false);
    expect(off?.shadow).toBe(false);

    liveEnabled = true;
    shadowEnabled = true;
    const on = await getMemoryV3SelectionForInspector("conv-5", 1);
    expect(on?.live).toBe(true);
    expect(on?.shadow).toBe(true);
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
