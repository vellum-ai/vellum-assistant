/**
 * Tests for `prune.ts` — the memory-v3 resident-footprint prune valve:
 *   - `parseInjectedSections` / `filterResidentSections` over the tombstones
 *     alone (an empty newest-copy map): section-boundary
 *     parsing at the `# memory/concepts/<slug>.md[ § <key>]` headers,
 *     byte-identical remainders, all-pruned → `""`, no-op → same reference,
 *     non-section chunks (`# Skills`, `# Skill:` / `# CLI command:` headers)
 *     terminating a section and surviving its prune, arbitrary `# ` lines
 *     inside a section body staying inside it, a body line that would
 *     read as a header arriving escaped from the renderer, and a legacy
 *     (pre-stamp) block filtered by card under each card's lead ref, never
 *     indexed;
 *   - `filterResidentPointerEntries`: a pruned section's line, or one whose
 *     section was re-injected further down, leaves the `<memory_pointer>`
 *     block; an emptied pointer collapses to `""`;
 *   - `planPrune`: no-op below the cap, oldest-first selection-recency ranking
 *     down to the target at section grain (each row's own `last_selected_at`,
 *     so two sections of one page selected on one turn both age from it), no
 *     lane exemptions, `injected_at` fallback for an unstamped row, zero-byte
 *     (capability) rows skipped, a truncated fork's inherited sections as
 *     candidates carrying their spans' bytes, idempotence below the cap;
 *   - `runPruneValve` + the live strip: the blocks memory-v3 placed (owned by
 *     object identity) stripped in place by header span, an unowned twin
 *     untouched even when byte-identical, all-pruned blocks removed,
 *     and the rehydration filter (the same `filterResidentSections` over
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

import * as schema from "../../../../persistence/schema/index.js";
import { wrapMemoryBlock, wrapMemoryPointerBlock } from "../memory-marker.js";
import {
  escapeInjectedBody,
  injectedSectionHeader,
  parseInjectedSections,
  renderedBytes,
} from "../substrate/injected-block-slugs.js";
import type { SectionRefSet } from "./ever-injected-store.js";
import { ensureMemoryV3InjectedSectionsSchema } from "./plugin-schema.js";
import {
  type InjectedBlock,
  type InjectedBlockFormat,
  sectionRefId,
} from "./types.js";

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
// The section store, which carries `planPrune`'s candidates and recency,
// lives on the dedicated memory connection, resolved via `getMemorySqlite`,
// stubbed to a second in-memory DB carrying the store's schema.
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
  filterResidentPointerEntries,
  filterResidentSections,
  flushPruneValveForTests,
  newestCopyIndexes,
  planPrune,
  runPruneValve,
  schedulePruneValve,
  stripPrunedSectionsFromMessages,
} = await import("./prune.js");

/** The filter over the tombstones alone: no newest-copy index, so only a
 *  pruned section (or a legacy card whose lead is pruned) leaves. */
function filterPrunedSections(
  inner: string,
  format: InjectedBlockFormat,
  pruned: SectionRefSet,
): string {
  return filterResidentSections(inner, format, 0, pruned, new Map());
}
const {
  getActiveSections,
  getInjected,
  getPrunedSections,
  markPruned,
  recordInjected,
  residentBytes,
  seedEverInjectedFromBlocks,
  touchSelected,
} = await import("./ever-injected-store.js");
const { markV3LiveBlock, v3LiveBlockFormat } = await import("./types.js");
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

/** A card exactly as the pre-stamp builds' card renderer shaped one: page
 *  header, the page's own `# Title` line, head, one-line section TOC. */
function legacyCard(slug: string): string {
  return `${injectedSectionHeader(slug, "")}\n# ${slug}\nhead of ${slug}\n\n[sections: §One · §Two]`;
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

/** A persisted block with its row's provenance: current (this build's
 *  render, stamped) or legacy (a pre-stamp row, read by card). */
const current = (inner: string): InjectedBlock => ({
  inner,
  format: "current",
});
const legacy = (inner: string): InjectedBlock => ({ inner, format: "legacy" });

/** A `<memory>` text block as memory-v3 places it in live history: owned by
 *  the strip through object identity, which records its format. */
function v3Block(
  text: string,
  format: InjectedBlockFormat = "current",
): ContentBlock {
  return markV3LiveBlock({ type: "text" as const, text }, format);
}

/** Clear a row's selection stamp, as a row written before the column existed
 *  carries none. */
function clearSelectionStamp(
  conversationId: string,
  slug: string,
  key: string,
): void {
  memorySqlite
    .query(
      /*sql*/ `
      UPDATE memory_v3_injected_sections SET last_selected_at = NULL
      WHERE conversation_id = ? AND slug = ? AND section_key = ?
    `,
    )
    .run(conversationId, slug, key);
}

function insertUserRowWithV3Block(
  conversationId: string,
  id: string,
  blockInner: string,
  format: InjectedBlockFormat = "current",
): void {
  // The persisting build stamps the block's format beside it; a legacy row
  // (persisted before the stamp existed) carries the block alone.
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
      JSON.stringify({
        memoryV3InjectedBlock: blockInner,
        ...(format === "current" ? { memoryV3InjectedBlockFormat: 2 } : {}),
      }),
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
    expect(filterPrunedSections(inner, "current", refSet(["page-z", ""]))).toBe(
      inner,
    );
    // A pruned key of a present page that is NOT in the block is a no-op too.
    expect(
      filterPrunedSections(inner, "current", refSet(["page-a", "Design"])),
    ).toBe(inner);
    expect(filterPrunedSections(inner, "current", new Map())).toBe(inner);
  });

  test("strips exactly the pruned section by header span, leaving siblings and the remainder byte-identical", () => {
    expect(
      filterPrunedSections(inner, "current", refSet(["page-a", "Notes"])),
    ).toBe(
      renderInjectionBlockInner([
        lead("page-a"),
        section("page-b", "Design#1"),
      ]),
    );
    expect(filterPrunedSections(inner, "current", refSet(["page-a", ""]))).toBe(
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
    expect(
      filterPrunedSections(block, "current", refSet(["page-a", "Setup"])),
    ).toBe(renderInjectionBlockInner([lead("page-b")]));
  });

  test("all sections pruned → empty string (caller drops the block)", () => {
    expect(
      filterPrunedSections(
        inner,
        "current",
        refSet(["page-a", ""], ["page-a", "Notes"], ["page-b", "Design#1"]),
      ),
    ).toBe("");
  });

  test("text with no section headers passes through unchanged", () => {
    const plain = "remember: user prefers tea";
    expect(filterPrunedSections(plain, "current", refSet(["page-a", ""]))).toBe(
      plain,
    );
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
    expect(filterPrunedSections(mixed, "current", refSet(["page-a", ""]))).toBe(
      renderInjectionBlockInner([CAPABILITY_CHUNK, section("page-b", "Notes")]),
    );
    // Capability chunk at the block END survives the prune of the last section.
    const trailing = renderInjectionBlockInner([
      lead("page-a"),
      CAPABILITY_CHUNK,
    ]);
    expect(
      filterPrunedSections(trailing, "current", refSet(["page-a", ""])),
    ).toBe(renderInjectionBlockInner([CAPABILITY_CHUNK]));
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
    // rendered body is exactly the page's body under the escaper.
    expect(
      filterPrunedSections(inner, "current", refSet(["page-a", "Notes"])),
    ).toBe(renderInjectionBlockInner([lead("page-b")]));
    expect(entry.slice(entry.indexOf("\n") + 1)).toBe(escapeInjectedBody(body));
  });

  test("a legacy block (a pre-stamp row's) is filtered by card under each lead ref: a tombstoned card leaves, the rest stays byte-identical, and the block is never indexed", () => {
    const cardA = legacyCard("page-a");
    const cardB = legacyCard("page-b");
    const legacyInner = [V3_INJECTION_HEADER, cardA, cardB].join("\n\n");

    // Nothing it holds tombstoned: the same reference back. A heading
    // section's tombstone names no card.
    expect(filterPrunedSections(legacyInner, "legacy", refSet())).toBe(
      legacyInner,
    );
    expect(
      filterPrunedSections(legacyInner, "legacy", refSet(["page-a", "One"])),
    ).toBe(legacyInner);
    // page-b's lead tombstoned before the upgrade: its card leaves and
    // page-a's rehydrates byte for byte.
    expect(
      filterPrunedSections(legacyInner, "legacy", refSet(["page-b", ""])),
    ).toBe([V3_INJECTION_HEADER, cardA].join("\n\n"));
    // Every card tombstoned: nothing left, the caller drops the block.
    expect(
      filterPrunedSections(
        legacyInner,
        "legacy",
        refSet(["page-a", ""], ["page-b", ""]),
      ),
    ).toBe("");

    // page-a's lead re-injected by a current block after that prune (which
    // cleared its tombstone): the current copy supersedes the card. The
    // legacy block contributes nothing to the index, so a legacy copy
    // sitting after a current one never retires it.
    const reinjected = renderInjectionBlockInner([lead("page-a")]);
    const newest = newestCopyIndexes([
      legacy(legacyInner),
      current(reinjected),
    ]);
    expect(newest.size).toBe(1);
    expect(
      filterResidentSections(legacyInner, "legacy", 0, refSet(), newest),
    ).toBe([V3_INJECTION_HEADER, cardB].join("\n\n"));
    expect(
      filterResidentSections(reinjected, "current", 1, refSet(), newest),
    ).toBe(reinjected);
    expect(
      filterResidentSections(
        reinjected,
        "current",
        0,
        refSet(),
        newestCopyIndexes([current(reinjected), legacy(legacyInner)]),
      ),
    ).toBe(reinjected);
  });

  test("a legacy block is read with its build's card grammar: an unescaped head line shaped like a page header opens a card, as it did for that build's valve", () => {
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
    const legacyInner = [V3_INJECTION_HEADER, cardA, lead("page-b")].join(
      "\n\n",
    );
    const forgedCard =
      "# memory/concepts/example.md\nmore lead prose\n\n[sections: §Notes · §Design]";
    expect(
      filterPrunedSections(legacyInner, "legacy", refSet(["page-a", ""])),
    ).toBe([V3_INJECTION_HEADER, forgedCard, lead("page-b")].join("\n\n"));
    expect(
      filterPrunedSections(legacyInner, "legacy", refSet(["example", ""])),
    ).toBe(
      [
        V3_INJECTION_HEADER,
        cardA.slice(0, cardA.indexOf(forgedCard)).trimEnd(),
        lead("page-b"),
      ].join("\n\n"),
    );
    // The same bytes under the current format are filtered by section.
    expect(
      filterPrunedSections(legacyInner, "current", refSet(["page-b", ""])),
    ).toBe([V3_INJECTION_HEADER, cardA].join("\n\n"));
  });

  test("all sections pruned keeps the preamble + capability chunks", () => {
    const mixed = renderInjectionBlockInner([lead("page-a"), CAPABILITY_CHUNK]);
    expect(
      filterPrunedSections(
        mixed,
        "current",
        refSet(["page-a", ""], ["page-b", ""]),
      ),
    ).toBe(renderInjectionBlockInner([CAPABILITY_CHUNK]));
  });
});

// ─── planPrune ───────────────────────────────────────────────────────────────

describe("newestCopyIndexes / filterResidentSections", () => {
  const oldA = renderInjectionBlockInner([lead("page-a"), lead("page-b")]);
  const newA = renderInjectionBlockInner([lead("page-a")]);

  test("a section injected on two blocks is current on the later one only; the earlier copy is superseded", () => {
    const newest = newestCopyIndexes([current(oldA), null, current(newA)]);
    expect(newest.get(sectionRefId({ slug: "page-a", key: "" }))).toBe(2);
    expect(newest.get(sectionRefId({ slug: "page-b", key: "" }))).toBe(0);

    expect(filterResidentSections(oldA, "current", 0, refSet(), newest)).toBe(
      renderInjectionBlockInner([lead("page-b")]),
    );
    expect(filterResidentSections(newA, "current", 2, refSet(), newest)).toBe(
      newA,
    );
    // Pruned still wins over currency.
    expect(
      filterResidentSections(
        newA,
        "current",
        2,
        refSet(["page-a", ""]),
        newest,
      ),
    ).toBe("");
  });

  test("a capability chunk rendered again on a later block supersedes the earlier copy under its capability slug; the earlier block's sections and its other capability stay", () => {
    const cli = "# CLI command: export\nExport a conversation.";
    const older = renderInjectionBlockInner([
      lead("page-a"),
      CAPABILITY_CHUNK,
      cli,
    ]);
    const newer = renderInjectionBlockInner([CAPABILITY_CHUNK]);
    const newest = newestCopyIndexes([current(older), current(newer)]);
    expect(
      newest.get(sectionRefId({ slug: "skills/meet-join", key: "" })),
    ).toBe(1);
    expect(
      newest.get(sectionRefId({ slug: "cli-commands/export", key: "" })),
    ).toBe(0);
    expect(newest.get(sectionRefId({ slug: "page-a", key: "" }))).toBe(0);

    // The older skill copy goes, and with it the skills hint chunk the
    // renderer adds beside skill entries; the lead and the CLI command stay,
    // byte-identical to a fresh render of those two.
    expect(filterResidentSections(older, "current", 0, refSet(), newest)).toBe(
      renderInjectionBlockInner([lead("page-a"), cli]),
    );
    expect(filterResidentSections(newer, "current", 1, refSet(), newest)).toBe(
      newer,
    );

    // A CLI command re-rendered later retires the same way; the skill and
    // its hint stay.
    const newerCli = renderInjectionBlockInner([cli]);
    const newestCli = newestCopyIndexes([current(older), current(newerCli)]);
    expect(
      filterResidentSections(older, "current", 0, refSet(), newestCli),
    ).toBe(renderInjectionBlockInner([lead("page-a"), CAPABILITY_CHUNK]));
  });

  test("a section on one block only is current there (the never-pruned case is unchanged)", () => {
    const newest = newestCopyIndexes([current(oldA)]);
    expect(filterResidentSections(oldA, "current", 0, refSet(), newest)).toBe(
      oldA,
    );
  });
});

describe("filterResidentPointerEntries", () => {
  const pointer = wrapMemoryPointerBlock(
    renderPointerInner([
      { slug: "page-a", key: "" },
      { slug: "page-a", key: "Notes" },
      { slug: "page-b", key: "Design#1" },
    ]),
  );
  const none = new Map<string, number>();

  test("returns the same reference when nothing named is pruned or superseded, or for a non-pointer block", () => {
    expect(
      filterResidentPointerEntries(pointer, 3, refSet(["page-c", ""]), none),
    ).toBe(pointer);
    const notPointer = wrapMemoryBlock(lead("page-a"));
    expect(
      filterResidentPointerEntries(notPointer, 3, refSet(["page-a", ""]), none),
    ).toBe(notPointer);
  });

  test("drops exactly the pruned sections' lines, keeping the lead line and the rest byte-identical", () => {
    expect(
      filterResidentPointerEntries(
        pointer,
        3,
        refSet(["page-a", "Notes"]),
        none,
      ),
    ).toBe(
      wrapMemoryPointerBlock(
        renderPointerInner([
          { slug: "page-a", key: "" },
          { slug: "page-b", key: "Design#1" },
        ]),
      ),
    );
  });

  test("drops a line whose section's newest copy sits on a later index; keeps one at or before the pointer", () => {
    const newest = new Map([
      [sectionRefId({ slug: "page-a", key: "" }), 5],
      [sectionRefId({ slug: "page-a", key: "Notes" }), 3],
      [sectionRefId({ slug: "page-b", key: "Design#1" }), 1],
    ]);
    // Index 3: page-a's lead is only re-injected at 5, so that line predates
    // the re-injection; the other two are already in context.
    expect(filterResidentPointerEntries(pointer, 3, refSet(), newest)).toBe(
      wrapMemoryPointerBlock(
        renderPointerInner([
          { slug: "page-a", key: "Notes" },
          { slug: "page-b", key: "Design#1" },
        ]),
      ),
    );
    // Index 5 and later keep every line.
    expect(filterResidentPointerEntries(pointer, 5, refSet(), newest)).toBe(
      pointer,
    );
  });

  test("returns '' when every entry is pruned or superseded (the caller drops the block)", () => {
    expect(
      filterResidentPointerEntries(
        pointer,
        3,
        refSet(["page-a", ""], ["page-a", "Notes"], ["page-b", "Design#1"]),
        none,
      ),
    ).toBe("");
    expect(
      filterResidentPointerEntries(
        pointer,
        0,
        refSet(),
        new Map([
          [sectionRefId({ slug: "page-a", key: "" }), 8],
          [sectionRefId({ slug: "page-a", key: "Notes" }), 8],
          [sectionRefId({ slug: "page-b", key: "Design#1" }), 8],
        ]),
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
    // Later turns re-select b, c, and d in that order; a keeps its record's
    // stamp (1_000).
    touchSelected("conv-1", [{ slug: "page-b", key: "" }], 2_000);
    touchSelected("conv-1", [{ slug: "page-c", key: "" }], 3_000);
    touchSelected("conv-1", [{ slug: "page-d", key: "" }], 4_000);

    const plan = planPrune(deps, "conv-1");
    expect(plan).toEqual({
      sections: [
        { slug: "page-a", key: "" },
        { slug: "page-b", key: "" },
      ],
      bytesFreed: 200,
    });
  });

  test("recency is per section row: two sections of one page selected on one turn both carry its stamp, and neither is evicted ahead of an older section", () => {
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
    // A later turn re-selects page-b's Notes, and the turn after it
    // re-selects page-a's Notes and Design together; page-a's lead keeps its
    // record's stamp.
    touchSelected("conv-1", [{ slug: "page-b", key: "Notes" }], 3_000);
    touchSelected(
      "conv-1",
      [
        { slug: "page-a", key: "Notes" },
        { slug: "page-a", key: "Design" },
      ],
      5_000,
    );

    // Resident 400 > max 300: page-a's lead (1_000) goes first, then page-b's
    // Notes (3_000); both sections selected at 5_000 survive.
    expect(planPrune(deps, "conv-1")!.sections).toEqual([
      { slug: "page-a", key: "" },
      { slug: "page-b", key: "Notes" },
    ]);
  });

  test("re-selection recency outranks injection order", () => {
    recordInjected(
      "conv-1",
      [{ slug: "page-old", key: "", bytes: 200 }],
      1_000,
    );
    recordInjected(
      "conv-1",
      [{ slug: "page-new", key: "", bytes: 200 }],
      2_000,
    );
    // page-old was injected first but re-selected most recently; page-new was
    // selected only at injection time.
    touchSelected("conv-1", [{ slug: "page-old", key: "" }], 9_000);

    const plan = planPrune(deps, "conv-1");
    expect(plan!.sections).toEqual([{ slug: "page-new", key: "" }]);
  });

  test("a row with no selection stamp ranks by injected_at", () => {
    recordInjected("conv-1", [{ slug: "page-a", key: "", bytes: 200 }], 5_000);
    recordInjected("conv-1", [{ slug: "page-b", key: "", bytes: 200 }], 1_000);
    recordInjected("conv-1", [{ slug: "page-c", key: "", bytes: 200 }], 9_000);
    clearSelectionStamp("conv-1", "page-b", "");
    clearSelectionStamp("conv-1", "page-c", "");

    // Resident 600 > max 300: page-b (injected 1_000, unstamped) goes first,
    // then page-a (stamped 5_000); page-c (injected 9_000, unstamped) is the
    // most recent and survives.
    expect(planPrune(deps, "conv-1")!.sections).toEqual([
      { slug: "page-b", key: "" },
      { slug: "page-a", key: "" },
    ]);
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
    touchSelected("conv-1", [{ slug: "page-b", key: "" }], 2_000);
    touchSelected("conv-1", [{ slug: "page-c", key: "" }], 3_000);

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
      [current(wrapMemoryBlock(renderInjectionBlockInner(entries)))],
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

  test("drops a pointer line written before its section's re-injection, keeps the one written after", () => {
    const oldBlock = renderInjectionBlockInner([
      lead("page-a"),
      lead("page-b"),
    ]);
    const newBlock = renderInjectionBlockInner([lead("page-a")]);
    const pointerA = () =>
      wrapMemoryPointerBlock(renderPointerInner([{ slug: "page-a", key: "" }]));
    const turn1 = userMessage(v3Block(wrapMemoryBlock(oldBlock)), "turn 1");
    const turn3 = userMessage(pointerA(), "turn 3");
    const turn8 = userMessage(v3Block(wrapMemoryBlock(newBlock)), "turn 8");
    const turn10 = userMessage(pointerA(), "turn 10");

    const stripped = stripPrunedSectionsFromMessages(
      [turn1, turn3, turn8, turn10],
      refSet(),
    );

    // Turn 1's superseded copy and turn 3's pointer (written before the
    // re-injection on turn 8) go; turn 8 and turn 10 stay byte-identical.
    expect(stripped).toBe(2);
    expect(turn1.content).toEqual([
      {
        type: "text",
        text: wrapMemoryBlock(renderInjectionBlockInner([lead("page-b")])),
      },
      { type: "text", text: "turn 1" },
    ]);
    expect(turn3.content).toEqual([{ type: "text", text: "turn 3" }]);
    expect(turn8.content).toEqual([
      { type: "text", text: wrapMemoryBlock(newBlock) },
      { type: "text", text: "turn 8" },
    ]);
    expect(turn10.content).toEqual([
      { type: "text", text: pointerA() },
      { type: "text", text: "turn 10" },
    ]);
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

  test("a re-entry copy of a skill chunk and of a CLI command retires once a later turn's persisted copy exists; the older block's section stays", () => {
    const cli = "# CLI command: export\nExport a conversation.";
    const reentry = userMessage(
      v3Block(
        wrapMemoryBlock(
          renderInjectionBlockInner([lead("page-a"), CAPABILITY_CHUNK, cli]),
        ),
      ),
      "turn 1",
    );
    const later = userMessage(
      v3Block(
        wrapMemoryBlock(renderInjectionBlockInner([CAPABILITY_CHUNK, cli])),
      ),
      "turn 2",
    );

    const stripped = stripPrunedSectionsFromMessages(
      [reentry, later],
      refSet(),
    );

    expect(stripped).toBe(1);
    expect(reentry.content[0]).toEqual({
      type: "text",
      text: wrapMemoryBlock(renderInjectionBlockInner([lead("page-a")])),
    });
    expect(later.content[0]).toEqual({
      type: "text",
      text: wrapMemoryBlock(renderInjectionBlockInner([CAPABILITY_CHUNK, cli])),
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
    // page-a was re-selected after both were injected: the drifted row is
    // the oldest candidate.
    touchSelected("conv-1", [{ slug: "page-a", key: "" }], 2_000);

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
    // Turn 1 re-selected page-a's Notes and turn 2 selected page-c; page-a's
    // lead keeps its record's stamp, the oldest.
    touchSelected("conv-1", [{ slug: "page-a", key: "Notes" }], 2_000);
    touchSelected("conv-1", [{ slug: "page-c", key: "" }], 3_000);

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
    expect(filterPrunedSections(innerTurn1, "current", pruned)).toBe("");
    expect(filterPrunedSections(innerTurn2, "current", pruned)).toBe(
      innerTurn2,
    );

    // Idempotent: resident is at 100 ≤ target → next pass is a no-op.
    expect(await runPruneValve("conv-1")).toBeNull();
  });

  test("the valve never plans a legacy card; the live strip drops a card tombstoned before the upgrade from a legacy block, re-marked legacy, and rehydration agrees", async () => {
    const stubCard = legacyCard("stub");
    const keptCard = legacyCard("kept");
    const legacyInner = [V3_INJECTION_HEADER, stubCard, keptCard].join("\n\n");
    const currentInner = renderInjectionBlockInner([lead("page-a")]);
    insertUserRowWithV3Block("conv-1", "m1", legacyInner, "legacy");
    insertUserRowWithV3Block("conv-1", "m2", currentInner);
    // The cards' rows are dedup-only (zero bytes, as the schema ensure copies
    // them in), stub's tombstoned before the upgrade; the current lead
    // carries its bytes.
    recordInjected(
      "conv-1",
      [
        { slug: "stub", key: "", bytes: 0 },
        { slug: "kept", key: "", bytes: 0 },
      ],
      1_000,
    );
    markPruned("conv-1", [{ slug: "stub", key: "" }], 1_500);
    recordInjected("conv-1", [{ slug: "page-a", key: "", bytes: 300 }], 2_000);

    const legacyBlock = v3Block(wrapMemoryBlock(legacyInner), "legacy");
    const liveMessages: Message[] = [
      {
        role: "user",
        content: [legacyBlock, { type: "text", text: "turn 1" }],
      },
      { role: "assistant", content: [{ type: "text", text: "reply 1" }] },
      {
        role: "user",
        content: [
          v3Block(wrapMemoryBlock(currentInner)),
          { type: "text", text: "turn 2" },
        ],
      },
    ];
    pruneConfig = { maxResidentBytes: 200, targetResidentBytes: 0 };
    const plan = await runPruneValve("conv-1", {
      liveMessages: () => liveMessages,
      now: 9_000,
    });

    expect(plan).toEqual({
      sections: [{ slug: "page-a", key: "" }],
      bytesFreed: 300,
    });
    // The legacy block lost stub's card, kept the other byte for byte, and
    // is owned in its place under its own format for the next strip.
    const remainder = [V3_INJECTION_HEADER, keptCard].join("\n\n");
    const stripped = liveMessages[0]!.content[0]!;
    expect(stripped).not.toBe(legacyBlock);
    expect(stripped).toEqual({
      type: "text",
      text: wrapMemoryBlock(remainder),
    });
    expect(v3LiveBlockFormat(stripped)).toBe("legacy");
    expect(liveMessages[2]!.content).toEqual([
      { type: "text", text: "turn 2" },
    ]);
    const pruned = getPrunedSections("conv-1");
    expect(pruned).toEqual(refSet(["stub", ""], ["page-a", ""]));
    expect(filterPrunedSections(legacyInner, "legacy", pruned)).toBe(remainder);
    expect(filterPrunedSections(currentInner, "current", pruned)).toBe("");
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
    expect(
      filterPrunedSections(inner, "current", getPrunedSections("conv-1")),
    ).toBe("");

    // Re-selection re-injects (recordInjected clears pruned_at), the section
    // is active again and the filter keeps it.
    recordInjected(
      "conv-1",
      [{ slug: "page-a", key: "Notes", bytes: 50 }],
      3_000,
    );
    expect(getActiveSections("conv-1")).toEqual(refSet(["page-a", "Notes"]));
    expect(
      filterPrunedSections(inner, "current", getPrunedSections("conv-1")),
    ).toBe(inner);
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
    touchSelected("conv-1", [{ slug: "page-b", key: "" }], 2_000);

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

describe("legacy card rows", () => {
  test("the schema ensure copies memory_v3_ever_injected rows in at zero bytes: dedup-only, never counted, never planned", () => {
    memorySqlite.run(/*sql*/ `
      CREATE TABLE memory_v3_ever_injected (
        conversation_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        injected_at INTEGER NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        pruned_at INTEGER,
        PRIMARY KEY (conversation_id, slug)
      )
    `);
    memorySqlite.run(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'page-a', 1000, 640, NULL)
    `);
    // The one-shot copy records itself in the checkpoint ledger; this suite
    // runs on a bare memory database, so hand the ensure a map-backed one.
    const values = new Map<string, string>();
    ensureMemoryV3InjectedSectionsSchema(memorySqlite, {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => {
        values.set(key, value);
      },
    });
    recordInjected("conv-1", [{ slug: "page-b", key: "", bytes: 100 }], 2_000);

    expect(getActiveSections("conv-1")).toEqual(
      refSet(["page-a", ""], ["page-b", ""]),
    );
    expect(residentBytes("conv-1")).toBe(100);
    expect(
      planPrune({ maxResidentBytes: 50, targetResidentBytes: 0 }, "conv-1"),
    ).toEqual({ sections: [{ slug: "page-b", key: "" }], bytesFreed: 100 });
  });
});
