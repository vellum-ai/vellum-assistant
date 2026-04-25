import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import { getSqliteFrom } from "../memory/db-connection.js";
import { migrateRenameInferenceProfileSnakeCase } from "../memory/migrations/228-rename-inference-profile-snake-case.js";
import * as schema from "../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function getColumnNames(raw: Database): string[] {
  return (
    raw.query(`PRAGMA table_info(conversations)`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

function bootstrapMinimalConversations(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

describe("migrate rename inferenceProfile → inference_profile", () => {
  test("renames the camelCase column to snake_case and preserves existing values", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapMinimalConversations(raw);
    raw.exec(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN inferenceProfile TEXT`,
    );
    raw.exec(/*sql*/ `
      INSERT INTO conversations (id, title, created_at, updated_at, inferenceProfile)
      VALUES ('conv-1', 'with profile', ${now}, ${now}, 'quality-optimized')
    `);

    migrateRenameInferenceProfileSnakeCase(db);

    const columns = getColumnNames(raw);
    expect(columns).toContain("inference_profile");
    expect(columns).not.toContain("inferenceProfile");

    const row = raw
      .query(
        `SELECT id, inference_profile FROM conversations WHERE id = 'conv-1'`,
      )
      .get() as { id: string; inference_profile: string | null } | null;
    expect(row).toEqual({
      id: "conv-1",
      inference_profile: "quality-optimized",
    });
  });

  test("is a no-op when the column is already snake_case", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapMinimalConversations(raw);
    raw.exec(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN inference_profile TEXT`,
    );
    raw.exec(/*sql*/ `
      INSERT INTO conversations (id, title, created_at, updated_at, inference_profile)
      VALUES ('conv-2', 'already snake', ${now}, ${now}, 'balanced')
    `);

    expect(() => migrateRenameInferenceProfileSnakeCase(db)).not.toThrow();

    const columns = getColumnNames(raw);
    expect(columns).toContain("inference_profile");
    expect(columns).not.toContain("inferenceProfile");

    const row = raw
      .query(`SELECT inference_profile FROM conversations WHERE id = 'conv-2'`)
      .get() as { inference_profile: string | null } | null;
    expect(row).toEqual({ inference_profile: "balanced" });
  });

  test("is a no-op when neither column exists", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapMinimalConversations(raw);
    const before = getColumnNames(raw);
    expect(before).not.toContain("inferenceProfile");
    expect(before).not.toContain("inference_profile");

    expect(() => migrateRenameInferenceProfileSnakeCase(db)).not.toThrow();

    const after = getColumnNames(raw);
    expect(after).not.toContain("inferenceProfile");
    expect(after).not.toContain("inference_profile");
  });

  test("re-running the migration is idempotent", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapMinimalConversations(raw);
    raw.exec(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN inferenceProfile TEXT`,
    );

    migrateRenameInferenceProfileSnakeCase(db);
    expect(() => migrateRenameInferenceProfileSnakeCase(db)).not.toThrow();

    const columns = getColumnNames(raw);
    expect(columns).toContain("inference_profile");
    expect(columns).not.toContain("inferenceProfile");
  });
});
