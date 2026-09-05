/**
 * Tests for `prune.ts` — the memory-v3 resident-footprint prune valve:
 *   - `parseInjectedSections` / `filterPrunedSections`: section-boundary
 *     parsing at the `# memory/concepts/<slug>.md[ § <key>]` headers,
 *     byte-identical remainders, all-pruned → `""`, no-op → same reference,
 *     non-section chunks (`# Skills`, `# Skill:` / `# CLI command:` headers)
 *     terminating a section and surviving its prune, arbitrary `# ` lines
 *     inside a section body staying inside it, and a body line that would
 *     read as a header arriving escaped from the renderer;
 *   - `filterPrunedPointerEntries`: a pruned section's line leaves the
 *     `<memory_pointer>` block, an emptied pointer collapses to `""`;
 *   - `planPrune`: no-op below the cap, oldest-first selection-recency ranking
 *     down to the target at section grain (a heading section's recency is its
 *     own title's selections; a lead's is any selection of the page), no lane
 *     exemptions, `injected_at` fallback, zero-byte (capability) rows
 *     skipped, a truncated fork's inherited sections as candidates carrying
 *     their spans' bytes, idempotence below the cap;
 *   - `runPruneValve` + the live strip: the blocks memory-v3 placed (owned by
 *     object identity) stripped in place by header span, an unowned twin
 *     untouched even when byte-identical, all-pruned blocks removed,
 *     and the rehydration filter (the same `filterPrunedSections` over
 *     persisted metadata) converging to the same bytes;
 *   - re-injection round-trip: `recordInjected` clears `pruned_at`, after
 *     which the filter keeps the section again;
 *   - accounting-drift regression: a section with recorded bytes but no
 *     locatable persisted text is tombstoned in ONE pass and the valve does
 *     not loop-fire afterwards;
 *   - `schedulePruneValve` deferred execution via `flushPruneValveForTests`.
 *
 * `mock.module` is process-global and leaks into sibling files in a directory
 * run, so the db-connection / config stubs DELEGATE to the real implementation
 * unless this test is actively running (`pruneMockActive`) — mirrors
 * `ever-injected-store.test.ts`.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ContentBlock, Message } from "@vellumai/plugin-api";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { ensureMemoryV3SelectionsSchema } from "../../../../persistence/migrations/338-move-memory-v3-selections-to-memory-db.js";
import { ensureMemoryV3InjectedSectionsSchema } from "../../../../persistence/migrations/378-add-memory-v3-injected-sections.js";
import * as schema from "../../../../persistence/schema/index.js";
import { wrapMemoryBlock, wrapMemoryPointerBlock } from "../memory-marker.js";
import {
  injectedSectionHeader,
  parseInjectedSections,
  unescapeInjectedBody,
} from "../substrate/injected-block-slugs.js";
import { renderedBytes } from "./card.js";

const realDb = {
  ...(await import("../../../../persistence/db-connection.js")),
};
const realMemoryConfig = { ...(await import("../config.js")) };

let pruneMockActive = false;
let pruneConfig: {
  maxResidentBytes: number;
  targetResidentBytes: number;
} | null = null;

let testSqlite: Database;
// `planPrune`'s recency ranking reads `memory_v3_selections` over the
// dedicated memory connection, resolved via `getMemorySqlite` — stubbed to a
// second in-memory DB carrying the relocated tables' schema.
let memorySqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  const db = drizzle(testSqlite, { schema });
  // Minimal `messages` shape, `collectPersistedV3Sections` reads only
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
  memorySqlite = new Database(":memory:");
  ensureMemoryV3SelectionsSchema(memorySqlite);
  ensureMemoryV3InjectedSectionsSchema(memorySqlite);
  return db;
}

mock.module("../../../../persistence/db-connection.js", () => ({
  ...realDb,
  getDb: () => (pruneMockActive ? testDb : realDb.getDb()),
  getSqliteFrom: (db: unknown) =>
    pruneMockActive
      ? testSqlite
      : realDb.getSqliteFrom(db as Parameters<typeof realDb.getSqliteFrom>[0]),
  getMemorySqlite: () =>
    pruneMockActive ? memorySqlite : realDb.getMemorySqlite(),
  getMemoryDb: () =>
    pruneMockActive ? drizzle(memorySqlite, { schema }) : realDb.getMemoryDb(),
}));

// Memory code resolves its config through the plugin's own accessor
// (`getMemoryConfig`), not `getConfig()`; the prune valve reads its bounds
// there, so only this stub is needed.
mock.module("../config.js", () => ({
  getMemoryConfig: () =>
    pruneMockActive
      ? { v3: { prune: pruneConfig ?? undefined } }
      : realMemoryConfig.getMemoryConfig(),
}));

const {
  filterPrunedPointerEntries,
  filterPrunedSections,
  filterResidentSections,
  flushPruneValveForTests,
  newestCopyIndexes,
  planPrune,
  runPruneValve,
  schedulePruneValve,
  stripPrunedSectionsFromMessages,
} = await import("./prune.js");
const {
  getActiveSections,
  getInjected,
  getKnownCardBytes,
  getPrunedSections,
  markPruned,
  recordInjected,
  seedEverInjectedFromBlocks,
} = await import("./ever-injected-store.js");
const { markV3LiveBlock } = await import("./types.js");
const { V3_INJECTION_HEADER, renderInjectionBlockInner, renderPointerInner } =
  await import("./render-injection.js");
const { renderV3SectionInjection } = await import("./page-content.js");

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A lead entry exactly as `renderV3SectionInjection` shapes it: page header,
 *  the page's own `# Title` line, lead text. */
function lead(slug: string): string {
  return `${injectedSectionHeader(slug, "")}\n# ${slug}\nlead for ${slug}`;
}

/** A heading-section entry: `§ key` header plus body. */
function section(slug: string, key: string): string {
  return `${injectedSectionHeader(slug, key)}\nbody of ${slug} ${key}`;
}

/** A capability chunk exactly as `renderCapabilityContent` shapes it: its own
 *  non-concept top-level header plus the capability content. */
const CAPABILITY_CHUNK = "# Skill: meet-join\nJoin a video meeting on request.";

function refSet(
  ...refs: Array<[slug: string, key: string]>
): Map<string, Set<string>> {
  const set = new Map<string, Set<string>>();
  for (const [slug, key] of refs) {
    let keys = set.get(slug);
    if (!keys) {
      keys = new Set();
      set.set(slug, keys);
    }
    keys.add(key);
  }
  return set;
}

/** A `<memory>` text block as memory-v3 places it in live history: owned by
 *  the strip through object identity. */
function v3Block(text: string): ContentBlock {
  return markV3LiveBlock({ type: "text" as const, text });
}

/** Give a lead entry the frozen length migration 378 (or the fork seeder)
 *  records for it, the block parser's evidence for a pre-escaping card. */
function freeze(conversationId: string, slug: string, bytes: number): void {
  memorySqlite
    .query(
      /*sql*/ `
      UPDATE memory_v3_injected_sections SET frozen_card_bytes = ?
      WHERE conversation_id = ? AND slug = ? AND section_key = ''
    `,
    )
    .run(bytes, conversationId, slug);
}

function insertSelection(
  conversationId: string,
  turn: number,
  slug: string,
  createdAt: number,
  sectionTitle: string | null = null,
): void {
  memorySqlite
    .query(
      /*sql*/ `
      INSERT OR REPLACE INTO memory_v3_selections
        (conversation_id, turn, slug, source, created_at, section_title)
      VALUES (?, ?, ?, 'needle', ?, ?)
    `,
    )
    .run(conversationId, turn, slug, createdAt, sectionTitle);
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

// ─── parseInjectedSections / filterPrunedSections ────────────────────────────

describe("parseInjectedSections / filterPrunedSections", () => {
  const inner = renderInjectionBlockInner([
    lead("page-a"),
    section("page-a", "Notes"),
    section("page-b", "Design#1"),
  ]);

  test("parses preamble and per-section pieces at the path headers, keyed by (slug, key)", () => {
    const parsed = parseInjectedSections(inner);
    expect(parsed.preamble).toBe(V3_INJECTION_HEADER);
    expect(parsed.sections.map((s) => [s.slug, s.key])).toEqual([
      ["page-a", ""],
      ["page-a", "Notes"],
      ["page-b", "Design#1"],
    ]);
    expect(parsed.sections[1]!.text).toBe(section("page-a", "Notes"));
  });

  test("skill catalog hint is a non-section piece and leaves the read-affordance preamble intact", () => {
    const mixed = renderInjectionBlockInner([
      "# Skill: telegram-setup\nSet up Telegram.",
      lead("page-a"),
    ]);
    const parsed = parseInjectedSections(mixed);
    expect(parsed.preamble).toBe(V3_INJECTION_HEADER);
    expect(parsed.sections.map((s) => s.slug)).toEqual(["page-a"]);
    expect(parsed.pieces.map((piece) => piece.kind)).toEqual([
      "other",
      "capability",
      "section",
    ]);
    expect(mixed).toContain("assistant plugins search <name>");
  });

  test("no pruned section present → returns the SAME reference (no-op)", () => {
    expect(filterPrunedSections(inner, refSet(["page-z", ""]))).toBe(inner);
    // A pruned key of a present page that is NOT in the block is a no-op too.
    expect(filterPrunedSections(inner, refSet(["page-a", "Design"]))).toBe(
      inner,
    );
    expect(filterPrunedSections(inner, new Map())).toBe(inner);
  });

  test("strips exactly the pruned section by header span, leaving siblings and the remainder byte-identical", () => {
    expect(filterPrunedSections(inner, refSet(["page-a", "Notes"]))).toBe(
      renderInjectionBlockInner([
        lead("page-a"),
        section("page-b", "Design#1"),
      ]),
    );
    expect(filterPrunedSections(inner, refSet(["page-a", ""]))).toBe(
      renderInjectionBlockInner([
        section("page-a", "Notes"),
        section("page-b", "Design#1"),
      ]),
    );
  });

  test("a `# ` line inside a section body is never a boundary", () => {
    // A lead's own `# Title` line follows the path header with a single
    // newline; a heading inside a section body (a code comment, an H1 in
    // page prose) can even sit on a blank-line seam. Neither splits the
    // section: only concept headers and capability chunks do.
    const bodyWithHeadings = `${injectedSectionHeader("page-a", "Setup")}\nrun this:\n\n# not a boundary\n\n# also inside`;
    const block = renderInjectionBlockInner([bodyWithHeadings, lead("page-b")]);
    const parsed = parseInjectedSections(block);
    expect(parsed.sections.map((s) => [s.slug, s.key])).toEqual([
      ["page-a", "Setup"],
      ["page-b", ""],
    ]);
    expect(parsed.sections[0]!.text).toBe(bodyWithHeadings);
    expect(filterPrunedSections(block, refSet(["page-a", "Setup"]))).toBe(
      renderInjectionBlockInner([lead("page-b")]),
    );
  });

  test("all sections pruned → empty string (caller drops the block)", () => {
    expect(
      filterPrunedSections(
        inner,
        refSet(["page-a", ""], ["page-a", "Notes"], ["page-b", "Design#1"]),
      ),
    ).toBe("");
  });

  test("text with no section headers passes through unchanged", () => {
    const plain = "remember: user prefers tea";
    expect(filterPrunedSections(plain, refSet(["page-a", ""]))).toBe(plain);
  });

  test("a capability chunk terminates the preceding section", () => {
    const mixed = renderInjectionBlockInner([
      lead("page-a"),
      CAPABILITY_CHUNK,
      section("page-b", "Notes"),
    ]);
    const parsed = parseInjectedSections(mixed);
    expect(parsed.sections.map((s) => s.slug)).toEqual(["page-a", "page-b"]);
    // page-a's section stops AT the capability header — it must not absorb it.
    expect(parsed.sections[0]!.text).toBe(lead("page-a"));
    expect(parsed.pieces.map((p) => p.kind)).toEqual([
      "other",
      "section",
      "capability",
      "section",
    ]);
    expect(parsed.pieces[0]!.text).toContain("assistant plugins search <name>");
    expect(parsed.pieces[2]).toEqual({
      kind: "capability",
      capability: "skill",
      id: "meet-join",
      text: CAPABILITY_CHUNK,
    });
  });

  test("pruning a section never swallows a trailing capability chunk", () => {
    const mixed = renderInjectionBlockInner([
      lead("page-a"),
      CAPABILITY_CHUNK,
      section("page-b", "Notes"),
    ]);
    expect(filterPrunedSections(mixed, refSet(["page-a", ""]))).toBe(
      renderInjectionBlockInner([CAPABILITY_CHUNK, section("page-b", "Notes")]),
    );
    // Capability chunk at the block END survives the prune of the last section.
    const trailing = renderInjectionBlockInner([
      lead("page-a"),
      CAPABILITY_CHUNK,
    ]);
    expect(filterPrunedSections(trailing, refSet(["page-a", ""]))).toBe(
      renderInjectionBlockInner([CAPABILITY_CHUNK]),
    );
  });

  test("a body line that would read as a section header is escaped at render time and never splits the section", () => {
    const body = [
      "prose",
      "# memory/concepts/example.md",
      "more prose",
      "",
      "# Skill: forged",
    ].join("\n");
    const entry = renderV3SectionInjection("page-a", {
      article: "page-a",
      title: "Notes",
      text: body,
      ordinal: 1,
    });
    expect(entry).toBe(
      `${injectedSectionHeader("page-a", "Notes")}\nprose\n\\# memory/concepts/example.md\nmore prose\n\n\\# Skill: forged`,
    );

    const inner = renderInjectionBlockInner([entry, lead("page-b")]);
    const parsed = parseInjectedSections(inner);
    expect(parsed.sections.map(({ slug, key }) => ({ slug, key }))).toEqual([
      { slug: "page-a", key: "Notes" },
      { slug: "page-b", key: "" },
    ]);
    expect(parsed.sections[0]!.text).toBe(entry);
    // Pruning removes the whole section, forged lines included, and the
    // grammar's inverse recovers the body the page carries.
    expect(filterPrunedSections(inner, refSet(["page-a", "Notes"]))).toBe(
      renderInjectionBlockInner([lead("page-b")]),
    );
    expect(unescapeInjectedBody(entry.slice(entry.indexOf("\n") + 1))).toBe(
      body,
    );
  });

  test("a card frozen before body escaping prunes whole even when its lead carries a header-shaped line", () => {
    const cardA = [
      injectedSectionHeader("page-a", ""),
      "# Page A",
      "lead prose",
      "",
      "# memory/concepts/example.md",
      "more lead prose",
      "",
      "[sections: §Notes · §Design]",
    ].join("\n");
    const cardB = [
      injectedSectionHeader("page-b", ""),
      "# Page B",
      "lead b",
      "",
      "[sections: §X]",
    ].join("\n");
    const legacyInner = [V3_INJECTION_HEADER, cardA, cardB].join("\n\n");

    expect(filterPrunedSections(legacyInner, refSet(["page-a", ""]))).toBe(
      [V3_INJECTION_HEADER, cardB].join("\n\n"),
    );
    // The header-shaped line names no section, so nothing keyed on it exists.
    expect(filterPrunedSections(legacyInner, refSet(["example", ""]))).toBe(
      legacyInner,
    );
  });

  test("a legacy card whose lead carries a capability-shaped line prunes whole (no phantom capability chunk survives)", () => {
    const card = [
      injectedSectionHeader("page-a", ""),
      "# Page A",
      "lead prose",
      "",
      "# Skill: example-skill",
      "prose about that skill",
      "",
      "[sections: §Notes]",
    ].join("\n");
    const legacyInner = [V3_INJECTION_HEADER, card, lead("page-b")].join(
      "\n\n",
    );
    expect(
      filterPrunedSections(
        legacyInner,
        refSet(["page-a", ""]),
        new Map([["page-a", renderedBytes(card)]]),
      ),
    ).toBe([V3_INJECTION_HEADER, lead("page-b")].join("\n\n"));
  });

  test("with the conversation's recorded card bytes, a headless legacy card after a sectionless one prunes on its own", () => {
    const stub = [
      injectedSectionHeader("stub", ""),
      "# Stub",
      "just a lead, no sections",
    ].join("\n");
    const headless = [
      injectedSectionHeader("headless", ""),
      "prose only, no title line",
      "",
      "[sections: §One]",
    ].join("\n");
    const legacyInner = [V3_INJECTION_HEADER, stub, headless].join("\n\n");
    const knownCardBytes = new Map([
      ["stub", renderedBytes(stub)],
      ["headless", renderedBytes(headless)],
    ]);

    expect(
      filterPrunedSections(
        legacyInner,
        refSet(["headless", ""]),
        knownCardBytes,
      ),
    ).toBe([V3_INJECTION_HEADER, stub].join("\n\n"));
    expect(
      filterPrunedSections(legacyInner, refSet(["stub", ""]), knownCardBytes),
    ).toBe([V3_INJECTION_HEADER, headless].join("\n\n"));
  });

  test("all sections pruned keeps the preamble + capability chunks", () => {
    const mixed = renderInjectionBlockInner([lead("page-a"), CAPABILITY_CHUNK]);
    expect(
      filterPrunedSections(mixed, refSet(["page-a", ""], ["page-b", ""])),
    ).toBe(renderInjectionBlockInner([CAPABILITY_CHUNK]));
  });
});

// ─── planPrune ───────────────────────────────────────────────────────────────

describe("newestCopyIndexes / filterResidentSections", () => {
  const oldA = renderInjectionBlockInner([lead("page-a"), lead("page-b")]);
  const newA = renderInjectionBlockInner([lead("page-a")]);

  test("a section injected on two blocks is current on the later one only; the earlier copy is superseded", () => {
    const newest = newestCopyIndexes([oldA, null, newA]);
    expect(newest.get("page-a\n")).toBe(2);
    expect(newest.get("page-b\n")).toBe(0);

    expect(filterResidentSections(oldA, 0, refSet(), newest)).toBe(
      renderInjectionBlockInner([lead("page-b")]),
    );
    expect(filterResidentSections(newA, 2, refSet(), newest)).toBe(newA);
    // Pruned still wins over currency.
    expect(
      filterResidentSections(newA, 2, refSet(["page-a", ""]), newest),
    ).toBe("");
  });

  test("a section on one block only is current there (the never-pruned case is unchanged)", () => {
    const newest = newestCopyIndexes([oldA]);
    expect(filterResidentSections(oldA, 0, refSet(), newest)).toBe(oldA);
  });
});

describe("filterPrunedPointerEntries", () => {
  const pointer = wrapMemoryPointerBlock(
    renderPointerInner([
      { slug: "page-a", key: "" },
      { slug: "page-a", key: "Notes" },
      { slug: "page-b", key: "Design#1" },
    ]),
  );

  test("returns the same reference when nothing named is pruned, or for a non-pointer block", () => {
    expect(filterPrunedPointerEntries(pointer, refSet(["page-c", ""]))).toBe(
      pointer,
    );
    const notPointer = wrapMemoryBlock(lead("page-a"));
    expect(filterPrunedPointerEntries(notPointer, refSet(["page-a", ""]))).toBe(
      notPointer,
    );
  });

  test("drops exactly the pruned sections' lines, keeping the lead line and the rest byte-identical", () => {
    expect(
      filterPrunedPointerEntries(pointer, refSet(["page-a", "Notes"])),
    ).toBe(
      wrapMemoryPointerBlock(
        renderPointerInner([
          { slug: "page-a", key: "" },
          { slug: "page-b", key: "Design#1" },
        ]),
      ),
    );
  });

  test("returns '' when every entry is pruned (the caller drops the block)", () => {
    expect(
      filterPrunedPointerEntries(
        pointer,
        refSet(["page-a", ""], ["page-a", "Notes"], ["page-b", "Design#1"]),
      ),
    ).toBe("");
  });
});

describe("planPrune", () => {
  const deps = { maxResidentBytes: 300, targetResidentBytes: 200 };

  test("no-op below (or at) the cap", () => {
    recordInjected("conv-1", [{ slug: "page-a", key: "", bytes: 300 }], 1_000);
    expect(planPrune(deps, "conv-1")).toBeNull();
  });

  test("over the cap: prunes oldest-first by last selection recency down to the target", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "page-a", key: "", bytes: 100 },
        { slug: "page-b", key: "", bytes: 100 },
        { slug: "page-c", key: "", bytes: 100 },
        { slug: "page-d", key: "", bytes: 100 },
      ],
      1_000,
    );
    insertSelection("conv-1", 0, "page-a", 1_000);
    insertSelection("conv-1", 0, "page-b", 2_000);
    insertSelection("conv-1", 0, "page-c", 3_000);
    insertSelection("conv-1", 0, "page-d", 4_000);

    const plan = planPrune(deps, "conv-1");
    expect(plan).toEqual({
      sections: [
        { slug: "page-a", key: "" },
        { slug: "page-b", key: "" },
      ],
      bytesFreed: 200,
    });
  });

  test("a heading section's recency is its own title's selections; the lead's is any selection of the page", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "page-a", key: "", bytes: 100 },
        { slug: "page-a", key: "Notes", bytes: 100 },
        { slug: "page-a", key: "Design", bytes: 100 },
        { slug: "page-b", key: "Notes", bytes: 100 },
      ],
      1_000,
    );
    // page-a: Notes selected at 2_000, Design at 5_000, and the page again
    // (no section) at 6_000, the lead reads 6_000, Notes 2_000, Design 5_000.
    insertSelection("conv-1", 0, "page-a", 2_000, "Notes");
    insertSelection("conv-1", 1, "page-a", 5_000, "Design");
    insertSelection("conv-1", 2, "page-a", 6_000, null);
    // page-b's Notes was selected at 3_000 under a DIFFERENT title only, so
    // its Notes section falls back to injected_at (1_000): the oldest.
    insertSelection("conv-1", 0, "page-b", 3_000, "Other");

    const plan = planPrune(deps, "conv-1");
    expect(plan!.sections).toEqual([
      { slug: "page-b", key: "Notes" },
      { slug: "page-a", key: "Notes" },
    ]);
  });

  test("a chunked heading (key~n) shares its title's recency", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "page-a", key: "Long~1", bytes: 200 },
        { slug: "page-b", key: "", bytes: 200 },
      ],
      1_000,
    );
    insertSelection("conv-1", 0, "page-a", 9_000, "Long");
    insertSelection("conv-1", 0, "page-b", 2_000);

    expect(planPrune(deps, "conv-1")!.sections).toEqual([
      { slug: "page-b", key: "" },
    ]);
  });

  test("a heading whose own title ends in #<n> decodes to its selections' title, distinct from a repeated heading", () => {
    // The literal heading `Topic#1` keys as `Topic##1`; a second `Topic`
    // heading keys as `Topic#1`. Each row must find its own selections.
    recordInjected(
      "conv-1",
      [
        { slug: "page-a", key: "Topic##1", bytes: 200 },
        { slug: "page-a", key: "Topic#1", bytes: 200 },
        { slug: "page-b", key: "", bytes: 200 },
      ],
      1_000,
    );
    insertSelection("conv-1", 0, "page-a", 9_000, "Topic#1");
    insertSelection("conv-1", 1, "page-a", 8_000, "Topic");
    insertSelection("conv-1", 0, "page-b", 2_000);

    // Resident 600 > max 300: page-b's lead (2_000) goes first, then the
    // repeated `Topic` section (8_000); the literal `Topic#1` heading (9_000)
    // is the most recent and survives.
    expect(planPrune(deps, "conv-1")!.sections).toEqual([
      { slug: "page-b", key: "" },
      { slug: "page-a", key: "Topic#1" },
    ]);
  });

  test("re-selection recency outranks injection order", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "page-old", key: "", bytes: 200 },
        { slug: "page-new", key: "", bytes: 200 },
      ],
      1_000,
    );
    // page-old was injected first but re-selected most recently; page-new was
    // selected only at injection time.
    insertSelection("conv-1", 0, "page-old", 1_000);
    insertSelection("conv-1", 1, "page-new", 2_000);
    insertSelection("conv-1", 5, "page-old", 9_000);

    const plan = planPrune(deps, "conv-1");
    expect(plan!.sections).toEqual([{ slug: "page-new", key: "" }]);
  });

  test("never-selected sections fall back to injected_at for recency", () => {
    recordInjected("conv-1", [{ slug: "page-a", key: "", bytes: 200 }], 5_000);
    recordInjected("conv-1", [{ slug: "page-b", key: "", bytes: 200 }], 1_000);

    const plan = planPrune(deps, "conv-1");
    expect(plan!.sections).toEqual([{ slug: "page-b", key: "" }]);
  });

  test("no lane exemptions: the oldest section is pruned whatever page it belongs to", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "core-page", key: "", bytes: 150 },
        { slug: "page-b", key: "", bytes: 150 },
        { slug: "page-c", key: "", bytes: 150 },
      ],
      1_000,
    );
    insertSelection("conv-1", 0, "core-page", 1_000);
    insertSelection("conv-1", 0, "page-b", 2_000);
    insertSelection("conv-1", 0, "page-c", 3_000);

    // Resident 450 > max 300: reaching the 200 target needs the two oldest,
    // and the core page's lead is simply the oldest.
    const plan = planPrune(deps, "conv-1");
    expect(plan!.sections).toEqual([
      { slug: "core-page", key: "" },
      { slug: "page-b", key: "" },
    ]);
  });

  test("zero-byte rows (capability slugs) are skipped (pruning them frees nothing)", () => {
    recordInjected(
      "conv-1",
      [
        { slug: "cli-commands/export", key: "", bytes: 0 },
        { slug: "skills/meet-join", key: "", bytes: 0 },
        { slug: "page-b", key: "", bytes: 400 },
      ],
      1_000,
    );

    const plan = planPrune(deps, "conv-1");
    expect(plan!.sections).toEqual([{ slug: "page-b", key: "" }]);
  });

  test("a truncated fork's inherited sections are candidates carrying the bytes of their inherited spans", () => {
    const entries = [lead("page-a"), section("page-a", "Notes")];
    seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-1",
      [wrapMemoryBlock(renderInjectionBlockInner(entries))],
      1_000,
    );
    const bytes = entries.map(renderedBytes);
    expect(
      getInjected("conv-1").map(({ slug, key, bytes }) => ({
        slug,
        key,
        bytes,
      })),
    ).toEqual([
      { slug: "page-a", key: "", bytes: bytes[0] },
      { slug: "page-a", key: "Notes", bytes: bytes[1] },
    ]);

    // Over the cap, the inherited sections are evicted like any other (both
    // fall back to the seed's injected_at, so the key order breaks the tie).
    const total = bytes[0]! + bytes[1]!;
    expect(
      planPrune(
        { maxResidentBytes: total - 1, targetResidentBytes: 0 },
        "conv-1",
      ),
    ).toEqual({
      sections: [
        { slug: "page-a", key: "" },
        { slug: "page-a", key: "Notes" },
      ],
      bytesFreed: total,
    });
  });

  test("returns null when only zero-byte candidates remain over the cap", () => {
    recordInjected(
      "conv-1",
      [{ slug: "skills/meet-join", key: "", bytes: 0 }],
      1_000,
    );
    expect(planPrune(deps, "conv-1")).toBeNull();
  });
});

// ─── live strip & v3-block identification ────────────────────────────────────

describe("stripPrunedSectionsFromMessages", () => {
  const innerAB = renderInjectionBlockInner([
    lead("page-a"),
    section("page-a", "Notes"),
    lead("page-b"),
  ]);
  function userMessage(...parts: Array<string | ContentBlock>): Message {
    return {
      role: "user",
      content: parts.map((part) =>
        typeof part === "string" ? { type: "text" as const, text: part } : part,
      ),
    };
  }

  test("strips pruned sections from v3-owned blocks in place by header span", () => {
    const message = userMessage(v3Block(wrapMemoryBlock(innerAB)), "hello");
    const messages = [message];

    const stripped = stripPrunedSectionsFromMessages(
      messages,
      refSet(["page-a", "Notes"]),
    );

    expect(stripped).toBe(1);
    expect(message.content).toEqual([
      {
        type: "text",
        text: wrapMemoryBlock(
          renderInjectionBlockInner([lead("page-a"), lead("page-b")]),
        ),
      },
      { type: "text", text: "hello" },
    ]);
  });

  test("drops a pruned section's line from pointer blocks too, removing a pointer left empty", () => {
    const pointerAB = wrapMemoryPointerBlock(
      renderPointerInner([
        { slug: "page-a", key: "Notes" },
        { slug: "page-b", key: "" },
      ]),
    );
    const pointerA = wrapMemoryPointerBlock(
      renderPointerInner([{ slug: "page-a", key: "Notes" }]),
    );
    const first = userMessage(v3Block(wrapMemoryBlock(innerAB)), "hello");
    const second = userMessage(pointerAB, "again");
    const third = userMessage(pointerA, "once more");

    const stripped = stripPrunedSectionsFromMessages(
      [first, second, third],
      refSet(["page-a", "Notes"]),
    );

    expect(stripped).toBe(3);
    expect(second.content).toEqual([
      {
        type: "text",
        text: wrapMemoryPointerBlock(
          renderPointerInner([{ slug: "page-b", key: "" }]),
        ),
      },
      { type: "text", text: "again" },
    ]);
    expect(third.content).toEqual([{ type: "text", text: "once more" }]);
  });

  test("strips a copy superseded by a re-injection later in the history, even though the section is not pruned", () => {
    const oldBlock = renderInjectionBlockInner([
      lead("page-a"),
      lead("page-b"),
    ]);
    const newBlock = renderInjectionBlockInner([lead("page-a")]);
    const first = userMessage(v3Block(wrapMemoryBlock(oldBlock)), "turn 1");
    const later = userMessage(v3Block(wrapMemoryBlock(newBlock)), "turn 8");

    const stripped = stripPrunedSectionsFromMessages(
      [first, { role: "assistant", content: [] }, later],
      refSet(),
    );

    expect(stripped).toBe(1);
    expect(first.content).toEqual([
      {
        type: "text",
        text: wrapMemoryBlock(renderInjectionBlockInner([lead("page-b")])),
      },
      { type: "text", text: "turn 1" },
    ]);
    expect(later.content).toEqual([
      { type: "text", text: wrapMemoryBlock(newBlock) },
      { type: "text", text: "turn 8" },
    ]);
  });

  test("removes a block whose sections are ALL pruned (matching rehydration's skip)", () => {
    const message = userMessage(v3Block(wrapMemoryBlock(innerAB)), "hello");

    stripPrunedSectionsFromMessages(
      [message],
      refSet(["page-a", ""], ["page-a", "Notes"], ["page-b", ""]),
    );

    expect(message.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("leaves a block memory-v3 did not place untouched, even one byte-identical to an owned block naming a pruned page", () => {
    // A pre-cutover v2 block can render the same bytes as a v3 entry (v2's
    // full-page fallback on a headingless page). Ownership is by object
    // identity, never text, so the unowned twin is never rewritten.
    const twin = userMessage(wrapMemoryBlock(innerAB), "hello");
    const owned = userMessage(v3Block(wrapMemoryBlock(innerAB)), "later");

    const stripped = stripPrunedSectionsFromMessages(
      [twin, owned],
      refSet(["page-a", "Notes"]),
    );

    expect(stripped).toBe(1);
    expect(twin.content).toEqual([
      { type: "text", text: wrapMemoryBlock(innerAB) },
      { type: "text", text: "hello" },
    ]);
    expect(owned.content[0]).toEqual({
      type: "text",
      text: wrapMemoryBlock(
        renderInjectionBlockInner([lead("page-a"), lead("page-b")]),
      ),
    });
  });

  test("stripping a section from a capability-bearing v3 block keeps the capability chunk", () => {
    const mixedInner = renderInjectionBlockInner([
      lead("page-a"),
      CAPABILITY_CHUNK,
      lead("page-b"),
    ]);
    const message = userMessage(v3Block(wrapMemoryBlock(mixedInner)), "hello");

    // Ownership is judged on the sections only, the capability chunk (a
    // non-section piece on both the persisted and live side) doesn't break it.
    const stripped = stripPrunedSectionsFromMessages(
      [message],
      refSet(["page-a", ""]),
    );

    expect(stripped).toBe(1);
    expect(message.content[0]).toEqual({
      type: "text",
      text: wrapMemoryBlock(
        renderInjectionBlockInner([CAPABILITY_CHUNK, lead("page-b")]),
      ),
    });
  });

  test("ignores assistant messages, non-memory blocks, and unpruned v3 blocks", () => {
    const assistant: Message = {
      role: "assistant",
      content: [{ type: "text", text: wrapMemoryBlock(innerAB) }],
    };
    const untouched = userMessage(v3Block(wrapMemoryBlock(innerAB)), "tail");
    const before = untouched.content;

    const stripped = stripPrunedSectionsFromMessages(
      [assistant, untouched],
      refSet(["page-z", ""]),
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

// ─── runPruneValve (end-to-end against the temp DB) ──────────────────────────

describe("runPruneValve", () => {
  test("below the cap: no-op, nothing marked pruned (idempotent)", async () => {
    pruneConfig = { maxResidentBytes: 1_000, targetResidentBytes: 500 };
    recordInjected("conv-1", [{ slug: "page-a", key: "", bytes: 100 }], 1_000);

    expect(await runPruneValve("conv-1")).toBeNull();
    expect(await runPruneValve("conv-1")).toBeNull();
    expect(getPrunedSections("conv-1").size).toBe(0);
  });

  test("missing prune config: bails before touching the store", async () => {
    pruneConfig = null;
    recordInjected("conv-1", [{ slug: "page-a", key: "", bytes: 100 }], 1_000);
    expect(await runPruneValve("conv-1")).toBeNull();
  });

  test("zero-byte capability rows never trigger the valve (the injector's bytes:0 contract)", async () => {
    // Capability content can never be located/stripped by slug, so the
    // injector records capability slugs at zero bytes — they contribute
    // nothing to the resident measure and are never candidates.
    insertUserRowWithV3Block(
      "conv-1",
      "m1",
      renderInjectionBlockInner([lead("page-a"), CAPABILITY_CHUNK]),
    );
    recordInjected(
      "conv-1",
      [
        { slug: "page-a", key: "", bytes: 100 },
        { slug: "skills/meet-join", key: "", bytes: 0 },
      ],
      1_000,
    );

    pruneConfig = { maxResidentBytes: 300, targetResidentBytes: 200 };
    expect(await runPruneValve("conv-1")).toBeNull();
    expect(getPrunedSections("conv-1").size).toBe(0);
  });

  test("accounting drift (bytes recorded, no locatable section) is tombstoned in ONE pass — no loop-fire", async () => {
    // Regression: a section whose recorded bytes have no locatable persisted
    // text (e.g. its metadata row was lost) pushes the store total over the
    // cap. The valve tombstones it like any candidate, the strip finds
    // nothing to remove, but the tombstone removes its bytes from the
    // resident accounting, so the very next pass is a no-op rather than the
    // valve loop-firing against bytes it cannot free.
    const inner = renderInjectionBlockInner([lead("page-a")]);
    insertUserRowWithV3Block("conv-1", "m1", inner);
    recordInjected(
      "conv-1",
      [
        { slug: "page-drifted", key: "", bytes: 500 }, // no persisted text anywhere
        { slug: "page-a", key: "", bytes: 100 },
      ],
      1_000,
    );
    insertSelection("conv-1", 0, "page-drifted", 1_000);
    insertSelection("conv-1", 0, "page-a", 2_000);

    const liveMessages: Message[] = [
      {
        role: "user",
        content: [
          v3Block(wrapMemoryBlock(inner)),
          { type: "text", text: "turn 1" },
        ],
      },
    ];

    // Resident 600 > max 300; tombstoning the drifted section's 500 bytes
    // reaches the 200 target in one pass without touching page-a.
    pruneConfig = { maxResidentBytes: 300, targetResidentBytes: 200 };
    const plan = await runPruneValve("conv-1", {
      liveMessages: () => liveMessages,
      now: 9_000,
    });
    expect(plan).toEqual({
      sections: [{ slug: "page-drifted", key: "" }],
      bytesFreed: 500,
    });
    expect(getActiveSections("conv-1")).toEqual(refSet(["page-a", ""]));

    // The live history is untouched, the drifted section had no text to
    // strip, and page-a was not pruned.
    expect(liveMessages[0]!.content).toEqual([
      { type: "text", text: wrapMemoryBlock(inner) },
      { type: "text", text: "turn 1" },
    ]);

    // One pass self-heals the accounting: the next run is a no-op (no
    // loop-fire), with nothing further tombstoned.
    expect(
      await runPruneValve("conv-1", { liveMessages: () => liveMessages }),
    ).toBeNull();
    expect(getPrunedSections("conv-1")).toEqual(refSet(["page-drifted", ""]));
  });

  test("over the cap: marks pruned, strips the live history by header span, and converges with rehydration", async () => {
    const innerTurn1 = renderInjectionBlockInner([
      lead("page-a"),
      section("page-a", "Notes"),
    ]);
    const innerTurn2 = renderInjectionBlockInner([lead("page-c")]);
    insertUserRowWithV3Block("conv-1", "m1", innerTurn1);
    insertUserRowWithV3Block("conv-1", "m2", innerTurn2);

    recordInjected(
      "conv-1",
      [
        { slug: "page-a", key: "", bytes: 100 },
        { slug: "page-a", key: "Notes", bytes: 100 },
        { slug: "page-c", key: "", bytes: 100 },
      ],
      1_000,
    );
    insertSelection("conv-1", 0, "page-a", 1_000);
    insertSelection("conv-1", 1, "page-a", 2_000, "Notes");
    insertSelection("conv-1", 1, "page-c", 3_000);

    // Live history as rehydration would build it, plus a v2-lookalike block
    // that must survive untouched.
    const v2Inner = `${V3_INJECTION_HEADER}\n\n# memory/concepts/page-a.md\nv2 summary of page a`;
    const liveMessages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: wrapMemoryBlock(v2Inner) },
          v3Block(wrapMemoryBlock(innerTurn1)),
          { type: "text", text: "turn 1" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      {
        role: "user",
        content: [
          v3Block(wrapMemoryBlock(innerTurn2)),
          { type: "text", text: "turn 2" },
        ],
      },
    ];

    pruneConfig = { maxResidentBytes: 250, targetResidentBytes: 100 };
    const plan = await runPruneValve("conv-1", {
      liveMessages: () => liveMessages,
      now: 9_000,
    });

    expect(plan).toEqual({
      sections: [
        { slug: "page-a", key: "" },
        { slug: "page-a", key: "Notes" },
      ],
      bytesFreed: 200,
    });
    expect(getActiveSections("conv-1")).toEqual(refSet(["page-c", ""]));
    expect(
      getInjected("conv-1").find(
        (row) => row.slug === "page-a" && row.key === "",
      )!.prunedAt,
    ).toBe(9_000);

    // Turn-1's v3 block lost BOTH pruned sections → removed outright; the
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
    const pruned = getPrunedSections("conv-1");
    expect(filterPrunedSections(innerTurn1, pruned)).toBe("");
    expect(filterPrunedSections(innerTurn2, pruned)).toBe(innerTurn2);

    // Idempotent: resident is at 100 ≤ target → next pass is a no-op.
    expect(await runPruneValve("conv-1")).toBeNull();
  });

  test("the valve parses legacy cards with the conversation's recorded card bytes: strip and rehydration split a headless card from a sectionless one", async () => {
    const stub = [
      injectedSectionHeader("stub", ""),
      "# Stub",
      "just a lead, no sections",
    ].join("\n");
    const headless = [
      injectedSectionHeader("headless", ""),
      "prose only, no title line",
      "",
      "[sections: §One]",
    ].join("\n");
    const legacyInner = [V3_INJECTION_HEADER, stub, headless].join("\n\n");
    insertUserRowWithV3Block("conv-1", "m1", legacyInner);
    // Both cards are recorded with the length the old injector measured (the
    // migration copies legacy card rows in as lead entries); the stub is the
    // older injection.
    recordInjected(
      "conv-1",
      [{ slug: "stub", key: "", bytes: renderedBytes(stub) }],
      1_000,
    );
    recordInjected(
      "conv-1",
      [{ slug: "headless", key: "", bytes: renderedBytes(headless) }],
      2_000,
    );
    freeze("conv-1", "stub", renderedBytes(stub));
    freeze("conv-1", "headless", renderedBytes(headless));

    const liveMessages: Message[] = [
      {
        role: "user",
        content: [
          v3Block(wrapMemoryBlock(legacyInner)),
          { type: "text", text: "turn 1" },
        ],
      },
    ];
    pruneConfig = {
      maxResidentBytes: renderedBytes(stub) + renderedBytes(headless) - 1,
      targetResidentBytes: renderedBytes(headless),
    };
    const plan = await runPruneValve("conv-1", {
      liveMessages: () => liveMessages,
      now: 9_000,
    });

    expect(plan).toEqual({
      sections: [{ slug: "stub", key: "" }],
      bytesFreed: renderedBytes(stub),
    });
    // Only the stub card leaves; the headless card is its own card because
    // its slug is recorded, so it stays byte-identical.
    expect(liveMessages[0]!.content).toEqual([
      {
        type: "text",
        text: wrapMemoryBlock([V3_INJECTION_HEADER, headless].join("\n\n")),
      },
      { type: "text", text: "turn 1" },
    ]);
    expect(
      filterPrunedSections(
        legacyInner,
        getPrunedSections("conv-1"),
        getKnownCardBytes("conv-1"),
      ),
    ).toBe([V3_INJECTION_HEADER, headless].join("\n\n"));
  });

  test("a legacy headless card whose lead is pruned and re-injected still parses by its frozen length: the old copy is superseded, not absorbed", () => {
    const stub = [
      injectedSectionHeader("stub", ""),
      "# Stub",
      "just a lead, no sections",
    ].join("\n");
    const headless = [
      injectedSectionHeader("headless", ""),
      "prose only, no title line",
      "",
      "[sections: §One]",
    ].join("\n");
    const legacyInner = [V3_INJECTION_HEADER, stub, headless].join("\n\n");
    recordInjected(
      "conv-1",
      [
        { slug: "stub", key: "", bytes: renderedBytes(stub) },
        { slug: "headless", key: "", bytes: renderedBytes(headless) },
      ],
      1_000,
    );
    freeze("conv-1", "stub", renderedBytes(stub));
    freeze("conv-1", "headless", renderedBytes(headless));
    markPruned("conv-1", [{ slug: "headless", key: "" }], 5_000);

    // The re-injection renders the lead under the current grammar and
    // refreshes the row's bytes, never its frozen length.
    const reinjected = renderInjectionBlockInner([lead("headless")]);
    recordInjected(
      "conv-1",
      [{ slug: "headless", key: "", bytes: renderedBytes(lead("headless")) }],
      8_000,
    );
    const known = getKnownCardBytes("conv-1");
    expect(known.get("headless")).toBe(renderedBytes(headless));

    const pruned = getPrunedSections("conv-1");
    const newest = newestCopyIndexes([legacyInner, reinjected], known);
    expect(filterResidentSections(legacyInner, 0, pruned, newest, known)).toBe(
      [V3_INJECTION_HEADER, stub].join("\n\n"),
    );
    expect(filterResidentSections(reinjected, 1, pruned, newest, known)).toBe(
      reinjected,
    );
  });

  test("a pruned section later re-selected re-injects and is kept by the filter again", async () => {
    const inner = renderInjectionBlockInner([section("page-a", "Notes")]);
    insertUserRowWithV3Block("conv-1", "m1", inner);
    recordInjected(
      "conv-1",
      [{ slug: "page-a", key: "Notes", bytes: 300 }],
      1_000,
    );

    pruneConfig = { maxResidentBytes: 200, targetResidentBytes: 100 };
    const plan = await runPruneValve("conv-1", {
      liveMessages: () => null,
      now: 2_000,
    });
    expect(plan!.sections).toEqual([{ slug: "page-a", key: "Notes" }]);
    expect(filterPrunedSections(inner, getPrunedSections("conv-1"))).toBe("");

    // Re-selection re-injects (recordInjected clears pruned_at), the section
    // is active again and the filter keeps it.
    recordInjected(
      "conv-1",
      [{ slug: "page-a", key: "Notes", bytes: 50 }],
      3_000,
    );
    expect(getActiveSections("conv-1")).toEqual(refSet(["page-a", "Notes"]));
    expect(filterPrunedSections(inner, getPrunedSections("conv-1"))).toBe(
      inner,
    );
  });
});

describe("schedulePruneValve", () => {
  test("defers the valve run; flush awaits completion", async () => {
    const inner = renderInjectionBlockInner([lead("page-a"), lead("page-b")]);
    insertUserRowWithV3Block("conv-1", "m1", inner);
    recordInjected(
      "conv-1",
      [
        { slug: "page-a", key: "", bytes: 200 },
        { slug: "page-b", key: "", bytes: 200 },
      ],
      1_000,
    );
    insertSelection("conv-1", 0, "page-a", 1_000);
    insertSelection("conv-1", 0, "page-b", 2_000);

    pruneConfig = { maxResidentBytes: 300, targetResidentBytes: 200 };
    schedulePruneValve("conv-1", { liveMessages: () => null });
    // Synchronously after scheduling, nothing has been pruned yet.
    expect(getPrunedSections("conv-1").size).toBe(0);

    await flushPruneValveForTests();
    expect(getPrunedSections("conv-1")).toEqual(refSet(["page-a", ""]));
  });

  test("valve failures are swallowed (never affect the turn)", async () => {
    pruneConfig = { maxResidentBytes: 0, targetResidentBytes: 0 };
    insertUserRowWithV3Block(
      "conv-1",
      "m1",
      renderInjectionBlockInner([lead("page-a")]),
    );
    recordInjected("conv-1", [{ slug: "page-a", key: "", bytes: 100 }], 1_000);
    schedulePruneValve("conv-1", {
      liveMessages: () => {
        throw new Error("boom");
      },
    });
    await flushPruneValveForTests();
    // The markPruned preceding the failing strip still landed; the error
    // itself did not propagate.
    expect(getPrunedSections("conv-1")).toEqual(refSet(["page-a", ""]));
  });
});
