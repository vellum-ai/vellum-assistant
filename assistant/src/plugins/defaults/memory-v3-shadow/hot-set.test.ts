/**
 * Tests for the frecency hot-set lane (`hot-set.ts`) and its config schema.
 *
 * `computeHotSet` takes the db handle directly (no module mocks needed):
 * each test seeds an in-memory SQLite db with `memory_v3_selections` rows
 * (via the real migration) and asserts the decayed-frequency ranking.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { MemoryV3ConfigSchema } from "../../../config/schemas/memory-v3.js";
import { migrateAddMemoryV3Selections } from "../../../memory/migrations/268-add-memory-v3-selections.js";
import * as schema from "../../../memory/schema.js";
import { computeHotSet, type HotSetOptions } from "./hot-set.js";

const HALF_LIFE_MS = 1000;
const NOW = 100_000;

let sqlite: Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrateAddMemoryV3Selections(db);
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
  return computeHotSet(
    { db },
    {
      k: 10,
      halfLifeMs: HALF_LIFE_MS,
      now: NOW,
      excludeSlugs: new Set<string>(),
      ...overrides,
    },
  );
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

  test("rejects negative k", () => {
    expect(() => MemoryV3ConfigSchema.parse({ hotSet: { k: -1 } })).toThrow();
  });

  test("rejects negative halfLifeDays", () => {
    expect(() =>
      MemoryV3ConfigSchema.parse({ hotSet: { halfLifeDays: -1 } }),
    ).toThrow();
  });
});
