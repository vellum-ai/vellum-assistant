/**
 * Tests for `prune.ts` — the memory-v3 resident-footprint prune valve:
 *   - `filterPrunedCardSections`: card-boundary parsing, byte-identical
 *     remainders, all-pruned → `""`, no-op → same reference;
 *   - `planPrune`: no-op below the cap, oldest-first selection-recency
 *     ranking down to the target, core/hot exemption, `injected_at` fallback,
 *     zero-byte (fork-seed) rows skipped, idempotence below the cap;
 *   - `runPruneValve` + the live strip: v3-owned blocks stripped in place,
 *     v2-lookalike blocks untouched, all-pruned blocks removed, and the
 *     rehydration filter (the same `filterPrunedCardSections` over persisted
 *     metadata) converging to the same bytes;
 *   - re-injection round-trip: `recordInjected` clears `pruned_at`, after
 *     which the filter keeps the slug again;
 *   - `schedulePruneValve` deferred execution via `flushPruneValveForTests`.
 *
 * `mock.module` is process-global and leaks into sibling files in a directory
 * run, so the db-connection / config stubs DELEGATE to the real implementation
 * unless this test is actively running (`pruneMockActive`) — mirrors
 * `ever-injected-store.test.ts`.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { wrapMemoryBlock } from "../../../memory/memory-marker.js";
import { migrateAddMemoryV3Selections } from "../../../memory/migrations/268-add-memory-v3-selections.js";
import { migrateAddMemoryV3EverInjected } from "../../../memory/migrations/275-add-memory-v3-ever-injected.js";
import * as schema from "../../../memory/schema.js";
import type { Message } from "../../../providers/types.js";

const realDb = { ...(await import("../../../memory/db-connection.js")) };
const realConfigLoader = { ...(await import("../../../config/loader.js")) };

let pruneMockActive = false;
let pruneConfig: {
  maxResidentBytes: number;
  targetResidentBytes: number;
} | null = null;

let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  const db = drizzle(testSqlite, { schema });
  migrateAddMemoryV3EverInjected(db);
  migrateAddMemoryV3Selections(db);
  // Minimal `messages` shape — `collectPersistedV3CardSections` reads only
  // `conversation_id` and `metadata`.
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

mock.module("../../../memory/db-connection.js", () => ({
  ...realDb,
  getDb: () => (pruneMockActive ? testDb : realDb.getDb()),
  getSqliteFrom: (db: unknown) =>
    pruneMockActive
      ? testSqlite
      : realDb.getSqliteFrom(db as Parameters<typeof realDb.getSqliteFrom>[0]),
}));

mock.module("../../../config/loader.js", () => ({
  ...realConfigLoader,
  getConfig: () =>
    pruneMockActive
      ? { memory: { v3: { prune: pruneConfig ?? undefined } } }
      : realConfigLoader.getConfig(),
}));

const {
  collectPersistedV3CardSections,
  filterPrunedCardSections,
  flushPruneValveForTests,
  parseCardSections,
  planPrune,
  runPruneValve,
  schedulePruneValve,
  stripPrunedCardsFromMessages,
} = await import("./prune.js");
const { getActiveSlugs, getInjected, getPrunedSlugs, recordInjected } =
  await import("./ever-injected-store.js");
const { V3_CARDS_INJECTION_HEADER, renderCardsBlockInner } =
  await import("./render-injection.js");

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A card exactly as `renderCard` shapes it: path header, head, TOC line. */
function card(slug: string): string {
  return `# memory/concepts/${slug}.md\nlead for ${slug}\n\n[sections: §One · §Two]`;
}

function insertSelection(
  conversationId: string,
  turn: number,
  slug: string,
  createdAt: number,
): void {
  testSqlite
    .query(
      /*sql*/ `
      INSERT OR REPLACE INTO memory_v3_selections
        (conversation_id, turn, slug, source, pinned, created_at)
      VALUES (?, ?, ?, 'needle', 0, ?)
    `,
    )
    .run(conversationId, turn, slug, createdAt);
}

function insertUserRowWithV3Block(
  conversationId: string,
  id: string,
  blockInner: string,
): void {
  testSqlite
    .query(
      /*sql*/ `
      INSERT INTO messages (id, conversation_id, role, content, metadata, created_at)
      VALUES (?, ?, 'user', '[]', ?, 0)
    `,
    )
    .run(
      id,
      conversationId,
      JSON.stringify({ memoryV3InjectedBlock: blockInner }),
    );
}

beforeEach(() => {
  pruneMockActive = true;
  pruneConfig = null;
  testDb = makeDb();
});

afterAll(async () => {
  await flushPruneValveForTests();
  pruneMockActive = false;
});

// ─── filterPrunedCardSections ────────────────────────────────────────────────

describe("parseCardSections / filterPrunedCardSections", () => {
  const inner = renderCardsBlockInner([
    card("page-a"),
    card("page-b"),
    card("page-c"),
  ]);

  test("parses preamble and per-card sections at the path headers", () => {
    const parsed = parseCardSections(inner);
    expect(parsed.preamble).toBe(V3_CARDS_INJECTION_HEADER);
    expect(parsed.sections.map((s) => s.slug)).toEqual([
      "page-a",
      "page-b",
      "page-c",
    ]);
    expect(parsed.sections[1]!.text).toBe(card("page-b"));
  });

  test("no pruned slug present → returns the SAME reference (no-op)", () => {
    expect(filterPrunedCardSections(inner, new Set(["page-z"]))).toBe(inner);
    expect(filterPrunedCardSections(inner, new Set())).toBe(inner);
  });

  test("strips pruned cards, leaving the remainder byte-identical to a fresh render", () => {
    const filtered = filterPrunedCardSections(inner, new Set(["page-b"]));
    expect(filtered).toBe(
      renderCardsBlockInner([card("page-a"), card("page-c")]),
    );
    // A `# Title` line inside a card head is NOT a card boundary.
    const headerInHead = `${V3_CARDS_INJECTION_HEADER}\n\n# memory/concepts/page-a.md\n# A Title Line\nlead\n\n# memory/concepts/page-b.md\nlead b`;
    expect(filterPrunedCardSections(headerInHead, new Set(["page-b"]))).toBe(
      `${V3_CARDS_INJECTION_HEADER}\n\n# memory/concepts/page-a.md\n# A Title Line\nlead`,
    );
  });

  test("all cards pruned → empty string (caller drops the block)", () => {
    expect(
      filterPrunedCardSections(inner, new Set(["page-a", "page-b", "page-c"])),
    ).toBe("");
  });

  test("text with no card headers passes through unchanged", () => {
    const plain = "remember: user prefers tea";
    expect(filterPrunedCardSections(plain, new Set(["page-a"]))).toBe(plain);
  });
});

// ─── planPrune ───────────────────────────────────────────────────────────────

describe("planPrune", () => {
  const deps = {
    maxResidentBytes: 300,
    targetResidentBytes: 200,
    exemptSlugs: new Set<string>(),
  };

  test("no-op below (or at) the cap", () => {
    recordInjected("conv-1", [{ slug: "page-a", bytes: 300 }], 1_000);
    expect(planPrune(deps, "conv-1")).toBeNull();
  });

  test("over the cap: prunes oldest-first by last selection recency down to the target", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "page-a", bytes: 100 },
        { slug: "page-b", bytes: 100 },
        { slug: "page-c", bytes: 100 },
        { slug: "page-d", bytes: 100 },
      ],
      1_000,
    );
    insertSelection("conv-1", 0, "page-a", 1_000);
    insertSelection("conv-1", 0, "page-b", 2_000);
    insertSelection("conv-1", 0, "page-c", 3_000);
    insertSelection("conv-1", 0, "page-d", 4_000);

    const plan = planPrune(deps, "conv-1");
    expect(plan).toEqual({ slugs: ["page-a", "page-b"], bytesFreed: 200 });
  });

  test("re-selection recency outranks injection order", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "page-old", bytes: 200 },
        { slug: "page-new", bytes: 200 },
      ],
      1_000,
    );
    // page-old was injected first but re-selected most recently; page-new was
    // selected only at injection time.
    insertSelection("conv-1", 0, "page-old", 1_000);
    insertSelection("conv-1", 1, "page-new", 2_000);
    insertSelection("conv-1", 5, "page-old", 9_000);

    const plan = planPrune(deps, "conv-1");
    expect(plan!.slugs).toEqual(["page-new"]);
  });

  test("never-selected slugs fall back to injected_at for recency", () => {
    recordInjected("conv-1", [{ slug: "page-a", bytes: 200 }], 5_000);
    recordInjected("conv-1", [{ slug: "page-b", bytes: 200 }], 1_000);

    const plan = planPrune(deps, "conv-1");
    expect(plan!.slugs).toEqual(["page-b"]);
  });

  test("core/hot exempt slugs are never pruned, even when oldest", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "core-page", bytes: 150 },
        { slug: "page-b", bytes: 150 },
        { slug: "page-c", bytes: 150 },
      ],
      1_000,
    );
    insertSelection("conv-1", 0, "core-page", 1_000);
    insertSelection("conv-1", 0, "page-b", 2_000);
    insertSelection("conv-1", 0, "page-c", 3_000);

    // Resident 450 > max 300: reaching the 200 target needs both non-exempt
    // pages — the exempt core page is skipped over even though it is oldest.
    const plan = planPrune(
      { ...deps, exemptSlugs: new Set(["core-page"]) },
      "conv-1",
    );
    expect(plan!.slugs).toEqual(["page-b", "page-c"]);
  });

  test("zero-byte fork-seed rows are skipped (pruning them frees nothing)", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "seeded", bytes: 0 },
        { slug: "page-b", bytes: 400 },
      ],
      1_000,
    );

    const plan = planPrune(deps, "conv-1");
    expect(plan!.slugs).toEqual(["page-b"]);
  });

  test("returns null when only exempt/zero-byte candidates remain over the cap", () => {
    recordInjected("conv-1", [{ slug: "core-page", bytes: 400 }], 1_000);
    expect(
      planPrune({ ...deps, exemptSlugs: new Set(["core-page"]) }, "conv-1"),
    ).toBeNull();
  });
});

// ─── live strip & v3-block identification ────────────────────────────────────

describe("stripPrunedCardsFromMessages", () => {
  const innerAB = renderCardsBlockInner([card("page-a"), card("page-b")]);
  const knownSections = new Set([card("page-a"), card("page-b")]);

  function userMessage(...texts: string[]): Message {
    return {
      role: "user",
      content: texts.map((text) => ({ type: "text" as const, text })),
    };
  }

  test("strips pruned cards from v3-owned blocks in place", () => {
    const message = userMessage(wrapMemoryBlock(innerAB), "hello");
    const messages = [message];

    const stripped = stripPrunedCardsFromMessages(
      messages,
      new Set(["page-a"]),
      knownSections,
    );

    expect(stripped).toBe(1);
    expect(message.content).toEqual([
      {
        type: "text",
        text: wrapMemoryBlock(renderCardsBlockInner([card("page-b")])),
      },
      { type: "text", text: "hello" },
    ]);
  });

  test("removes a block whose cards are ALL pruned (matching rehydration's skip)", () => {
    const message = userMessage(wrapMemoryBlock(innerAB), "hello");

    stripPrunedCardsFromMessages(
      [message],
      new Set(["page-a", "page-b"]),
      knownSections,
    );

    expect(message.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("leaves v2-lookalike blocks untouched even when they name a pruned slug", () => {
    // Same wrapper + header convention, but the section body is a v2 SUMMARY,
    // not a card — so it fails the known-sections ownership test.
    const v2Inner = `${V3_CARDS_INJECTION_HEADER}\n\n# memory/concepts/page-a.md\nv2 summary of page a`;
    const message = userMessage(wrapMemoryBlock(v2Inner));

    const stripped = stripPrunedCardsFromMessages(
      [message],
      new Set(["page-a"]),
      knownSections,
    );

    expect(stripped).toBe(0);
    expect(message.content).toEqual([
      { type: "text", text: wrapMemoryBlock(v2Inner) },
    ]);
  });

  test("ignores assistant messages, non-memory blocks, and unpruned v3 blocks", () => {
    const assistant: Message = {
      role: "assistant",
      content: [{ type: "text", text: wrapMemoryBlock(innerAB) }],
    };
    const untouched = userMessage(wrapMemoryBlock(innerAB), "tail");
    const before = untouched.content;

    const stripped = stripPrunedCardsFromMessages(
      [assistant, untouched],
      new Set(["page-z"]),
      knownSections,
    );

    expect(stripped).toBe(0);
    // No-op leaves the original content array reference in place.
    expect(untouched.content).toBe(before);
    expect(assistant.content[0]).toEqual({
      type: "text",
      text: wrapMemoryBlock(innerAB),
    });
  });
});

describe("collectPersistedV3CardSections", () => {
  test("collects card sections from persisted v3 metadata, skipping malformed rows", () => {
    insertUserRowWithV3Block(
      "conv-1",
      "m1",
      renderCardsBlockInner([card("page-a")]),
    );
    insertUserRowWithV3Block(
      "conv-1",
      "m2",
      renderCardsBlockInner([card("page-b")]),
    );
    testSqlite
      .query(
        /*sql*/ `
        INSERT INTO messages (id, conversation_id, role, content, metadata, created_at)
        VALUES ('m3', 'conv-1', 'user', '[]', 'not json memoryV3InjectedBlock', 0)
      `,
      )
      .run();

    const sections = collectPersistedV3CardSections("conv-1");
    expect(sections).toEqual(new Set([card("page-a"), card("page-b")]));
    expect(collectPersistedV3CardSections("conv-other").size).toBe(0);
  });
});

// ─── runPruneValve (end-to-end against the temp DB) ──────────────────────────

describe("runPruneValve", () => {
  test("below the cap: no-op, nothing marked pruned (idempotent)", async () => {
    pruneConfig = { maxResidentBytes: 1_000, targetResidentBytes: 500 };
    recordInjected("conv-1", [{ slug: "page-a", bytes: 100 }], 1_000);

    expect(
      await runPruneValve("conv-1", { exemptSlugs: new Set() }),
    ).toBeNull();
    expect(
      await runPruneValve("conv-1", { exemptSlugs: new Set() }),
    ).toBeNull();
    expect(getPrunedSlugs("conv-1").size).toBe(0);
  });

  test("missing prune config: bails before touching the store", async () => {
    pruneConfig = null;
    recordInjected("conv-1", [{ slug: "page-a", bytes: 100 }], 1_000);
    expect(
      await runPruneValve("conv-1", { exemptSlugs: new Set() }),
    ).toBeNull();
  });

  test("over the cap: marks pruned, strips the live history, and converges with rehydration", async () => {
    const innerTurn1 = renderCardsBlockInner([card("page-a"), card("page-b")]);
    const innerTurn2 = renderCardsBlockInner([card("page-c")]);
    insertUserRowWithV3Block("conv-1", "m1", innerTurn1);
    insertUserRowWithV3Block("conv-1", "m2", innerTurn2);

    recordInjected(
      "conv-1",
      [
        { slug: "page-a", bytes: 100 },
        { slug: "page-b", bytes: 100 },
        { slug: "page-c", bytes: 100 },
      ],
      1_000,
    );
    insertSelection("conv-1", 0, "page-a", 1_000);
    insertSelection("conv-1", 0, "page-b", 2_000);
    insertSelection("conv-1", 1, "page-c", 3_000);

    // Live history as rehydration would build it, plus a v2-lookalike block
    // that must survive untouched.
    const v2Inner = `${V3_CARDS_INJECTION_HEADER}\n\n# memory/concepts/page-a.md\nv2 summary of page a`;
    const liveMessages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: wrapMemoryBlock(v2Inner) },
          { type: "text", text: wrapMemoryBlock(innerTurn1) },
          { type: "text", text: "turn 1" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      {
        role: "user",
        content: [
          { type: "text", text: wrapMemoryBlock(innerTurn2) },
          { type: "text", text: "turn 2" },
        ],
      },
    ];

    pruneConfig = { maxResidentBytes: 250, targetResidentBytes: 100 };
    const plan = await runPruneValve("conv-1", {
      exemptSlugs: new Set(),
      liveMessages: () => liveMessages,
      now: 9_000,
    });

    expect(plan).toEqual({ slugs: ["page-a", "page-b"], bytesFreed: 200 });
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["page-c"]));
    expect(getInjected("conv-1").get("page-a")!.prunedAt).toBe(9_000);

    // Turn-1's v3 block lost BOTH pruned cards → removed outright; the
    // v2-lookalike and turn-2's block are byte-identical.
    expect(liveMessages[0]!.content).toEqual([
      { type: "text", text: wrapMemoryBlock(v2Inner) },
      { type: "text", text: "turn 1" },
    ]);
    expect(liveMessages[2]!.content).toEqual([
      { type: "text", text: wrapMemoryBlock(innerTurn2) },
      { type: "text", text: "turn 2" },
    ]);

    // Rehydration converges: the same filter over the persisted metadata
    // produces exactly what the live strip left in place.
    const pruned = getPrunedSlugs("conv-1");
    expect(filterPrunedCardSections(innerTurn1, pruned)).toBe("");
    expect(filterPrunedCardSections(innerTurn2, pruned)).toBe(innerTurn2);

    // Idempotent: resident is at 100 ≤ target → next pass is a no-op.
    expect(
      await runPruneValve("conv-1", { exemptSlugs: new Set() }),
    ).toBeNull();
  });

  test("a pruned page later re-selected re-injects and is kept by the filter again", async () => {
    const inner = renderCardsBlockInner([card("page-a")]);
    insertUserRowWithV3Block("conv-1", "m1", inner);
    recordInjected("conv-1", [{ slug: "page-a", bytes: 300 }], 1_000);

    pruneConfig = { maxResidentBytes: 200, targetResidentBytes: 100 };
    const plan = await runPruneValve("conv-1", {
      exemptSlugs: new Set(),
      liveMessages: () => null,
      now: 2_000,
    });
    expect(plan!.slugs).toEqual(["page-a"]);
    expect(filterPrunedCardSections(inner, getPrunedSlugs("conv-1"))).toBe("");

    // Re-selection re-injects (PR 4 contract: recordInjected clears
    // pruned_at) — the slug is active again and the filter keeps its card.
    recordInjected("conv-1", [{ slug: "page-a", bytes: 50 }], 3_000);
    expect(getActiveSlugs("conv-1")).toEqual(new Set(["page-a"]));
    expect(filterPrunedCardSections(inner, getPrunedSlugs("conv-1"))).toBe(
      inner,
    );
  });
});

describe("schedulePruneValve", () => {
  test("defers the valve run; flush awaits completion", async () => {
    const inner = renderCardsBlockInner([card("page-a"), card("page-b")]);
    insertUserRowWithV3Block("conv-1", "m1", inner);
    recordInjected(
      "conv-1",
      [
        { slug: "page-a", bytes: 200 },
        { slug: "page-b", bytes: 200 },
      ],
      1_000,
    );
    insertSelection("conv-1", 0, "page-a", 1_000);
    insertSelection("conv-1", 0, "page-b", 2_000);

    pruneConfig = { maxResidentBytes: 300, targetResidentBytes: 200 };
    schedulePruneValve("conv-1", {
      exemptSlugs: new Set(),
      liveMessages: () => null,
    });
    // Synchronously after scheduling, nothing has been pruned yet.
    expect(getPrunedSlugs("conv-1").size).toBe(0);

    await flushPruneValveForTests();
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["page-a"]));
  });

  test("valve failures are swallowed (never affect the turn)", async () => {
    pruneConfig = { maxResidentBytes: 0, targetResidentBytes: 0 };
    recordInjected("conv-1", [{ slug: "page-a", bytes: 100 }], 1_000);
    schedulePruneValve("conv-1", {
      exemptSlugs: new Set(),
      liveMessages: () => {
        throw new Error("boom");
      },
    });
    await flushPruneValveForTests();
    // The markPruned preceding the failing strip still landed; the error
    // itself did not propagate.
    expect(getPrunedSlugs("conv-1")).toEqual(new Set(["page-a"]));
  });
});
