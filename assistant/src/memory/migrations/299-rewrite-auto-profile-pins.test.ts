import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateRewriteAutoProfilePins } from "./299-rewrite-auto-profile-pins.js";

function createTestDb(withColumns = true) {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY
      ${withColumns ? ", inference_profile TEXT" : ""}
    )
  `);
  sqlite.exec(/*sql*/ `
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY
      ${withColumns ? ", inference_profile TEXT" : ""}
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function pin(sqlite: Database, table: string, id: string): string | null {
  return (
    sqlite
      .query(`SELECT inference_profile FROM ${table} WHERE id = ?`)
      .get(id) as { inference_profile: string | null }
  ).inference_profile;
}

describe("migration 299: rewrite auto profile pins", () => {
  test("rewrites auto pins to balanced on conversations and schedules", () => {
    const { sqlite, db } = createTestDb();
    sqlite.run(
      `INSERT INTO conversations (id, inference_profile) VALUES ('c1', 'auto'), ('c2', 'quality-optimized'), ('c3', NULL)`,
    );
    sqlite.run(
      `INSERT INTO cron_jobs (id, inference_profile) VALUES ('j1', 'auto'), ('j2', 'balanced')`,
    );

    migrateRewriteAutoProfilePins(db);

    expect(pin(sqlite, "conversations", "c1")).toBe("balanced");
    expect(pin(sqlite, "conversations", "c2")).toBe("quality-optimized");
    expect(pin(sqlite, "conversations", "c3")).toBeNull();
    expect(pin(sqlite, "cron_jobs", "j1")).toBe("balanced");
    expect(pin(sqlite, "cron_jobs", "j2")).toBe("balanced");
  });

  test("is idempotent", () => {
    const { sqlite, db } = createTestDb();
    sqlite.run(
      `INSERT INTO conversations (id, inference_profile) VALUES ('c1', 'auto')`,
    );

    migrateRewriteAutoProfilePins(db);
    expect(() => migrateRewriteAutoProfilePins(db)).not.toThrow();
    expect(pin(sqlite, "conversations", "c1")).toBe("balanced");
  });

  test("skips a table that has no inference_profile column", () => {
    const { db } = createTestDb(false);
    expect(() => migrateRewriteAutoProfilePins(db)).not.toThrow();
  });
});
