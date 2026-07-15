/**
 * Tests for the frecency hot-set lane (`hot-set.ts`) and its config schema.
 *
 * `computeHotSet` reads `memory_v3_selections` over the dedicated memory
 * connection: each test installs an in-memory SQLite db into the `memory`
 * singleton slot (where the accessor resolves its connection), seeds it with
 * selection rows, and asserts the decayed-frequency ranking.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { MemoryV3ConfigSchema } from "../../../../config/schemas/memory-v3.js";
import {
  clearStoredDb,
  setStoredDb,
} from "../../../../persistence/db-singleton.js";
import { ensureMemoryV3SelectionsSchema } from "../../../../persistence/migrations/338-move-memory-v3-selections-to-memory-db.js";
import * as schema from "../../../../persistence/schema/index.js";
import { computeHotSet, type HotSetOptions } from "./hot-set.js";

const HALF_LIFE_MS = 1000;
const NOW = 100_000;

// Fail-soft seam: `mock.module` is process-global and leaks into sibling
// files in a directory run, so the stub DELEGATES to the real accessor unless
// a test flips `memoryDbUnavailable`.
const realMemoryDb = { ...(await import("../memory-db.js")) };
let memoryDbUnavailable = false;
mock.module("../memory-db.js", () => ({
  ...realMemoryDb,
  memorySqliteOrNull: (context: string) =>
    memoryDbUnavailable ? null : realMemoryDb.memorySqliteOrNull(context),
}));

let sqlite: Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  ensureMemoryV3SelectionsSchema(sqlite);
  setStoredDb("memory", drizzle(sqlite, { schema }), () => sqlite.close());
});

afterEach(() => {
  memoryDbUnavailable = false;
  clearStoredDb("memory");
});

let nextTurn = 0;
/** Insert one selection row per createdAt (distinct turns keep the PK unique). */
function seed(slug: string, createdAts: number[]): void {
  const stmt = sqlite.query(
    `INSERT INTO memory_v3_selections (conversation_id, turn, slug, source, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const createdAt of createdAts) {
    stmt.run("conv-1", nextTurn++, slug, "needle", 0, createdAt);
  }
}

function hotSet(overrides: Partial<HotSetOptions> = {}) {
  return computeHotSet({
    k: 10,
    halfLifeMs: HALF_LIFE_MS,
    now: NOW,
    excludeSlugs: new Set<string>(),
    ...overrides,
  });
}

describe("computeHotSet", () => {
  test("empty table yields empty result", () => {
    expect(hotSet()).toEqual([]);
  });

  test("newer selections outweigh older ones at the same count", () => {
    seed("page-old", [NOW - 10 * HALF_LIFE_MS, NOW - 10 * HALF_LIFE_MS]);
    seed("page-new", [NOW, NOW]);
    const result = hotSet();
    expect(result.map((e) => e.slug)).toEqual(["page-new", "page-old"]);
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
  });

  test("decay halves at exactly one half-life", () => {
    seed("page-a", [NOW]);
    seed("page-b", [NOW - HALF_LIFE_MS]);
    const result = hotSet();
    const bySlug = new Map(result.map((e) => [e.slug, e.score]));
    expect(bySlug.get("page-a")).toBeCloseTo(1, 10);
    expect(bySlug.get("page-b")).toBeCloseTo(0.5, 10);
  });

  test("scores sum across a slug's selections", () => {
    seed("page-a", [NOW, NOW - HALF_LIFE_MS]);
    expect(hotSet()[0]!.score).toBeCloseTo(1.5, 10);
  });

  test("k cut keeps only the top-k", () => {
    seed("page-a", [NOW, NOW, NOW]);
    seed("page-b", [NOW, NOW]);
    seed("page-c", [NOW]);
    expect(hotSet({ k: 2 }).map((e) => e.slug)).toEqual(["page-a", "page-b"]);
  });

  test("excludeSlugs filters before the k cut", () => {
    seed("page-a", [NOW, NOW, NOW]);
    seed("page-b", [NOW, NOW]);
    seed("page-c", [NOW]);
    const result = hotSet({ k: 2, excludeSlugs: new Set(["page-a"]) });
    expect(result.map((e) => e.slug)).toEqual(["page-b", "page-c"]);
  });

  test("ties break deterministically by slug ascending", () => {
    seed("page-b", [NOW]);
    seed("page-a", [NOW]);
    seed("page-c", [NOW]);
    expect(hotSet().map((e) => e.slug)).toEqual(["page-a", "page-b", "page-c"]);
  });

  test("deterministic for fixed inputs", () => {
    seed("page-a", [NOW, NOW - 3 * HALF_LIFE_MS]);
    seed("page-b", [NOW - HALF_LIFE_MS]);
    expect(hotSet()).toEqual(hotSet());
  });

  test("future-dated rows are clamped to weight 1", () => {
    seed("page-a", [NOW + 50 * HALF_LIFE_MS]);
    expect(hotSet()[0]!.score).toBeCloseTo(1, 10);
  });

  test("degrades to an empty hot set when the memory database is unavailable", () => {
    seed("page-a", [NOW]);
    memoryDbUnavailable = true;
    expect(hotSet()).toEqual([]);
  });
});

describe("MemoryV3ConfigSchema hotSet", () => {
  test("defaults apply when omitted", () => {
    const config = MemoryV3ConfigSchema.parse({});
    expect(config.hotSet).toEqual({ k: 40, halfLifeDays: 14 });
  });

  test("explicit values parse", () => {
    const config = MemoryV3ConfigSchema.parse({
      hotSet: { k: 5, halfLifeDays: 7 },
    });
    expect(config.hotSet).toEqual({ k: 5, halfLifeDays: 7 });
  });

  test("zero k disables the lane", () => {
    const config = MemoryV3ConfigSchema.parse({ hotSet: { k: 0 } });
    expect(config.hotSet.k).toBe(0);
  });

  test("rejects negative k", () => {
    expect(() => MemoryV3ConfigSchema.parse({ hotSet: { k: -1 } })).toThrow();
  });

  test("rejects negative halfLifeDays", () => {
    expect(() =>
      MemoryV3ConfigSchema.parse({ hotSet: { halfLifeDays: -1 } }),
    ).toThrow();
  });
});
