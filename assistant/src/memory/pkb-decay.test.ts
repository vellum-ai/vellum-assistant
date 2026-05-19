import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getSqlite, resetDb } from "./db-connection.js";
import { initializeDb } from "./db-init.js";
import {
  listPkbPreferences,
  listRecentPkbEntities,
  upsertPkbEntity,
  upsertPkbPreference,
} from "./personal-knowledge-store.js";
import { runPkbDecayPass } from "./pkb-decay.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

describe("runPkbDecayPass", () => {
  beforeAll(() => {
    resetDb();
    initializeDb();
  });

  beforeEach(() => {
    const sqlite = getSqlite();
    sqlite.run("DELETE FROM pkb_episodes");
    sqlite.run("DELETE FROM pkb_preferences");
    sqlite.run("DELETE FROM pkb_entities");
  });

  test("no-op when there are no rows", () => {
    const metrics = runPkbDecayPass({ now: Date.now() });
    expect(metrics.entitiesScanned).toBe(0);
    expect(metrics.entitiesUpdated).toBe(0);
    expect(metrics.preferencesScanned).toBe(0);
    expect(metrics.preferencesUpdated).toBe(0);
  });

  test("decays entity confidence by half-life from last_reinforced_at", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const inserted = upsertPkbEntity({
      entityType: "person",
      canonicalName: "Alice",
      confidence: 0.8,
    });
    const sqlite = getSqlite();
    sqlite.run("UPDATE pkb_entities SET last_reinforced_at = ? WHERE id = ?", [
      t0,
      inserted.id,
    ]);

    const halfLifeDays = 10;
    const metrics = runPkbDecayPass({
      now: t0 + halfLifeDays * ONE_DAY_MS,
      entityHalfLifeDays: halfLifeDays,
    });

    expect(metrics.entitiesScanned).toBe(1);
    expect(metrics.entitiesUpdated).toBe(1);

    const rows = listRecentPkbEntities({ limit: 1 });
    expect(rows[0]?.confidence).toBeCloseTo(0.4, 5);
  });

  test("decays preferences using preference half-life", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const pref = upsertPkbPreference({
      key: "writing-style",
      value: "concise",
      confidence: 0.9,
      signal: "positive",
    });
    const sqlite = getSqlite();
    sqlite.run(
      "UPDATE pkb_preferences SET last_reinforced_at = ?, confidence = ? WHERE id = ?",
      [t0, 0.9, pref.id],
    );

    const metrics = runPkbDecayPass({
      now: t0 + 15 * ONE_DAY_MS,
      preferenceHalfLifeDays: 15,
    });

    expect(metrics.preferencesScanned).toBe(1);
    expect(metrics.preferencesUpdated).toBe(1);

    const [updated] = listPkbPreferences({});
    expect(updated?.confidence).toBeCloseTo(0.45, 5);
  });

  test("respects floor and does not push confidence to zero", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const inserted = upsertPkbEntity({
      entityType: "person",
      canonicalName: "Bob",
      confidence: 0.07,
    });
    const sqlite = getSqlite();
    sqlite.run("UPDATE pkb_entities SET last_reinforced_at = ? WHERE id = ?", [
      t0,
      inserted.id,
    ]);

    const metrics = runPkbDecayPass({
      now: t0 + 1_000 * ONE_DAY_MS,
      entityHalfLifeDays: 30,
      confidenceFloor: 0.05,
    });
    expect(metrics.entitiesUpdated).toBe(1);
    const rows = listRecentPkbEntities({ limit: 1 });
    expect(rows[0]?.confidence).toBe(0.05);
  });

  test("skips rows already below the floor", () => {
    const t0 = Date.UTC(2026, 0, 1);
    upsertPkbEntity({
      entityType: "person",
      canonicalName: "Carol",
      confidence: 0.03,
    });
    const metrics = runPkbDecayPass({
      now: t0 + 100 * ONE_DAY_MS,
      confidenceFloor: 0.05,
    });
    expect(metrics.entitiesScanned).toBe(0);
    expect(metrics.entitiesUpdated).toBe(0);
  });
});
