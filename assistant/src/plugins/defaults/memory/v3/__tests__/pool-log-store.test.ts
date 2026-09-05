/**
 * Tests for `pool-log-store.ts`, memory-v3's per-turn selector pool audit:
 *   - `buildPoolRecord` lays the pool out in cache order (core, hot, fresh,
 *     always-candidate cards, then the finder tail), tags each entry with its
 *     lane and the slug's matched section, and marks `chosen` by membership in
 *     the selection set (a finder hit on a stable-prefix page appears twice);
 *   - `writePool` / `readPoolForTurn` round-trip the record, a re-observed
 *     turn replaces its row, and an absent turn reads `null`;
 *   - both degrade (no-op write, `null` read) when the memory connection is
 *     unavailable, and an unreadable `candidates_json` reads `null`;
 *   - `ensureMemoryV3PoolsSchema` is idempotent.
 *
 * `mock.module` is process-global and leaks into sibling files in a directory
 * run, so the db-connection stub DELEGATES to the real implementation unless
 * this test is actively running (`storeMockActive`). Mirrors
 * `selection-log-store.test.ts`.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { ensureMemoryV3PoolsSchema } from "../../../../../persistence/migrations/377-add-memory-v3-pools.js";
import type { OrchestrateResult } from "../orchestrate.js";
import type {
  PoolCandidateRecord,
  PoolLane,
  PoolRecord,
} from "../pool-log-store.js";
import type { Section, Slug } from "../types.js";

const realDb = {
  ...(await import("../../../../../persistence/db-connection.js")),
};

let storeMockActive = false;
// When false, the stubbed `getMemorySqlite` resolves to null: the contract
// the store sees when the dedicated memory database cannot be opened.
let memoryDbAvailable = true;

let memorySqlite: Database;
makeDb();
function makeDb() {
  memorySqlite = new Database(":memory:");
  ensureMemoryV3PoolsSchema(memorySqlite);
}

mock.module("../../../../../persistence/db-connection.js", () => ({
  ...realDb,
  getMemorySqlite: () =>
    storeMockActive
      ? memoryDbAvailable
        ? memorySqlite
        : null
      : realDb.getMemorySqlite(),
}));

const { buildPoolRecord, readPoolForTurn, writePool } =
  await import("../pool-log-store.js");

beforeEach(() => {
  storeMockActive = true;
  memoryDbAvailable = true;
  makeDb();
});

afterAll(() => {
  storeMockActive = false;
});

function section(article: Slug, title: string, ordinal: number): Section {
  return { article, title, text: `${title} body`, ordinal };
}

/**
 * A turn whose pool spans every lane kind: a core card the dense lane ALSO hit
 * (so it appears twice), unchosen hot / fresh / always cards, a needle hit on
 * the page lead, an unchosen entity hit with a heading, and an edge hit with
 * no matched section.
 */
function orchestrated(): OrchestrateResult {
  return {
    selections: [
      { slug: "core/page" },
      { slug: "topic/a" },
      { slug: "topic/c" },
    ],
    matchedSections: new Map([
      ["core/page", section("core/page", "Recent", 3)],
      ["topic/a", section("topic/a", "", 0)],
      ["topic/b", section("topic/b", "Details", 2)],
    ]),
    lanes: {
      core: ["core/page"],
      hot: ["hot/page"],
      fresh: ["fresh/page"],
      always: ["skills/example"],
      finder: [
        { slug: "topic/a", descriptor: "", lane: "needle" },
        { slug: "core/page", descriptor: "", lane: "dense" },
        { slug: "topic/b", descriptor: "", lane: "entity" },
        { slug: "topic/c", descriptor: "", lane: "edge" },
      ],
    },
  };
}

const card = (
  slug: string,
  lane: PoolLane,
  chosen: boolean,
): PoolCandidateRecord => ({
  slug,
  lane,
  section_title: null,
  section_ordinal: null,
  chosen,
});

describe("buildPoolRecord", () => {
  test("lays the pool out in cache order with lanes, sections, and verdicts", () => {
    const record = buildPoolRecord(orchestrated());

    expect(record.candidates).toEqual([
      card("core/page", "core", true),
      card("hot/page", "hot", false),
      card("fresh/page", "fresh", false),
      card("skills/example", "always", false),
      {
        slug: "topic/a",
        lane: "needle",
        section_title: "",
        section_ordinal: 0,
        chosen: true,
      },
      // The dense lane also hit the core page: it is listed again as a finder
      // line carrying its matched section, and reads chosen like the card.
      {
        slug: "core/page",
        lane: "dense",
        section_title: "Recent",
        section_ordinal: 3,
        chosen: true,
      },
      {
        slug: "topic/b",
        lane: "entity",
        section_title: "Details",
        section_ordinal: 2,
        chosen: false,
      },
      card("topic/c", "edge", true),
    ]);
    expect(record.pool_size).toBe(8);
    // Distinct pages kept (core/page counts once), not chosen entries.
    expect(record.selected_count).toBe(3);
  });

  test("an empty pool records zero candidates", () => {
    expect(
      buildPoolRecord({
        selections: [],
        matchedSections: new Map(),
        lanes: { core: [], hot: [], fresh: [], always: [], finder: [] },
      }),
    ).toEqual({ candidates: [], pool_size: 0, selected_count: 0 });
  });
});

describe("writePool / readPoolForTurn", () => {
  test("round-trips the record for the exact (conversation, turn)", () => {
    const record = buildPoolRecord(orchestrated());
    writePool("conv-1", 4, record);

    expect(readPoolForTurn("conv-1", 4)).toEqual(record);
    expect(readPoolForTurn("conv-1", 3)).toBeNull();
    expect(readPoolForTurn("conv-2", 4)).toBeNull();
  });

  test("writes message_id NULL for the turn-end backfill to stamp", () => {
    writePool("conv-1", 4, buildPoolRecord(orchestrated()));

    const row = memorySqlite
      .query(
        `SELECT message_id, pool_size, selected_count FROM memory_v3_pools
         WHERE conversation_id = 'conv-1' AND turn = 4`,
      )
      .get();
    expect(row).toEqual({ message_id: null, pool_size: 8, selected_count: 3 });
  });

  test("a re-observed turn replaces its row", () => {
    writePool("conv-1", 4, buildPoolRecord(orchestrated()));
    const smaller: PoolRecord = {
      candidates: [card("only/page", "core", true)],
      pool_size: 1,
      selected_count: 1,
    };
    writePool("conv-1", 4, smaller);

    expect(readPoolForTurn("conv-1", 4)).toEqual(smaller);
    expect(
      memorySqlite.query(`SELECT COUNT(*) AS n FROM memory_v3_pools`).get(),
    ).toEqual({ n: 1 });
  });

  test("degrades to a no-op write and a null read when the memory database is unavailable", () => {
    memoryDbAvailable = false;
    expect(() =>
      writePool("conv-1", 4, buildPoolRecord(orchestrated())),
    ).not.toThrow();
    expect(readPoolForTurn("conv-1", 4)).toBeNull();

    // Nothing landed while the connection was down.
    memoryDbAvailable = true;
    expect(readPoolForTurn("conv-1", 4)).toBeNull();
  });

  test("an unreadable candidates_json reads null instead of throwing", () => {
    memorySqlite
      .query(
        `INSERT INTO memory_v3_pools
           (conversation_id, turn, message_id, created_at,
            pool_size, selected_count, candidates_json)
         VALUES ('conv-1', 4, NULL, 1, 2, 1, 'not json')`,
      )
      .run();
    expect(readPoolForTurn("conv-1", 4)).toBeNull();
  });
});

describe("ensureMemoryV3PoolsSchema", () => {
  test("is idempotent and creates both indexes", () => {
    expect(() => ensureMemoryV3PoolsSchema(memorySqlite)).not.toThrow();

    const indexes = memorySqlite
      .query(`PRAGMA index_list(memory_v3_pools)`)
      .all() as Array<{ name: string }>;
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has("idx_memory_v3_pools_message")).toBe(true);
    expect(names.has("idx_memory_v3_pools_conv")).toBe(true);
  });
});
