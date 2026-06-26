import { existsSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getWorkspaceConfigPath } from "../../util/platform.js";
import * as schema from "../schema.js";
import { migrateRewriteFrontierProfilePins } from "./306-rewrite-frontier-profile-pins.js";

function writeWorkspaceConfig(config: Record<string, unknown>): void {
  writeFileSync(getWorkspaceConfigPath(), JSON.stringify(config));
}

afterEach(() => {
  const path = getWorkspaceConfigPath();
  if (existsSync(path)) rmSync(path);
});

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

describe("migration 306: rewrite frontier profile pins", () => {
  test("rewrites frontier pins to quality-optimized on conversations and schedules", () => {
    const { sqlite, db } = createTestDb();
    sqlite.run(
      `INSERT INTO conversations (id, inference_profile) VALUES ('c1', 'frontier'), ('c2', 'balanced'), ('c3', NULL)`,
    );
    sqlite.run(
      `INSERT INTO cron_jobs (id, inference_profile) VALUES ('j1', 'frontier'), ('j2', 'quality-optimized')`,
    );

    migrateRewriteFrontierProfilePins(db);

    expect(pin(sqlite, "conversations", "c1")).toBe("quality-optimized");
    // Unrelated pins and NULLs are left untouched.
    expect(pin(sqlite, "conversations", "c2")).toBe("balanced");
    expect(pin(sqlite, "conversations", "c3")).toBeNull();
    expect(pin(sqlite, "cron_jobs", "j1")).toBe("quality-optimized");
    expect(pin(sqlite, "cron_jobs", "j2")).toBe("quality-optimized");
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();
    sqlite.run(
      `INSERT INTO conversations (id, inference_profile) VALUES ('c1', 'frontier')`,
    );

    migrateRewriteFrontierProfilePins(db);
    expect(() => migrateRewriteFrontierProfilePins(db)).not.toThrow();
    expect(pin(sqlite, "conversations", "c1")).toBe("quality-optimized");
  });

  test("skips a table that has no inference_profile column", () => {
    const { db } = createTestDb(false);
    expect(() => migrateRewriteFrontierProfilePins(db)).not.toThrow();
  });

  test("leaves pins alone when frontier is a user-owned profile", () => {
    // The workspace migration keeps a user-owned profile of this name, so its
    // pins still resolve and must not be switched to quality-optimized.
    writeWorkspaceConfig({
      llm: { profiles: { frontier: { source: "user" } } },
    });
    const { sqlite, db } = createTestDb();
    sqlite.run(
      `INSERT INTO conversations (id, inference_profile) VALUES ('c1', 'frontier')`,
    );

    migrateRewriteFrontierProfilePins(db);

    expect(pin(sqlite, "conversations", "c1")).toBe("frontier");
  });

  test("rewrites pins when frontier is the managed profile in config", () => {
    writeWorkspaceConfig({
      llm: { profiles: { frontier: { source: "managed" } } },
    });
    const { sqlite, db } = createTestDb();
    sqlite.run(
      `INSERT INTO conversations (id, inference_profile) VALUES ('c1', 'frontier')`,
    );

    migrateRewriteFrontierProfilePins(db);

    expect(pin(sqlite, "conversations", "c1")).toBe("quality-optimized");
  });
});
