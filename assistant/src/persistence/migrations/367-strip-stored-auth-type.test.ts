import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateStripStoredAuthType } from "./367-strip-stored-auth-type.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE provider_connections (
      name        TEXT PRIMARY KEY,
      provider    TEXT NOT NULL,
      auth        TEXT NOT NULL,
      label       TEXT,
      base_url    TEXT,
      models      TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function insertRow(
  sqlite: Database,
  name: string,
  provider: string,
  auth: string,
): void {
  sqlite
    .query(
      /*sql*/ `INSERT INTO provider_connections (name, provider, auth, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1)`,
    )
    .run(name, provider, auth);
}

function readAuth(sqlite: Database, name: string): string | undefined {
  const row = sqlite
    .query(`SELECT auth FROM provider_connections WHERE name = ?`)
    .get(name) as { auth: string } | null;
  return row?.auth;
}

describe("migration 367: strip stored auth type", () => {
  test("strips the type key from every auth kind, keeping the credential payload", () => {
    const { sqlite, db } = createTestDb();
    insertRow(
      sqlite,
      "anthropic-personal",
      "anthropic",
      '{"type":"api_key","credential":"credential/anthropic/api_key"}',
    );
    insertRow(sqlite, "vellum", "vellum", '{"type":"platform"}');
    insertRow(sqlite, "ollama-personal", "ollama", '{"type":"none"}');
    insertRow(
      sqlite,
      "chatgpt-subscription",
      "chatgpt",
      '{"type":"oauth_subscription","credential":"credential/chatgpt/access_token"}',
    );

    migrateStripStoredAuthType(db);

    expect(JSON.parse(readAuth(sqlite, "anthropic-personal")!)).toEqual({
      credential: "credential/anthropic/api_key",
    });
    expect(JSON.parse(readAuth(sqlite, "vellum")!)).toEqual({});
    expect(JSON.parse(readAuth(sqlite, "ollama-personal")!)).toEqual({});
    expect(JSON.parse(readAuth(sqlite, "chatgpt-subscription")!)).toEqual({
      credential: "credential/chatgpt/access_token",
    });
  });

  test("leaves already-typeless rows untouched", () => {
    const { sqlite, db } = createTestDb();
    insertRow(
      sqlite,
      "openrouter-personal",
      "openrouter",
      '{"credential":"credential/openrouter/api_key"}',
    );
    insertRow(sqlite, "vellum", "vellum", "{}");

    migrateStripStoredAuthType(db);

    expect(readAuth(sqlite, "openrouter-personal")).toBe(
      '{"credential":"credential/openrouter/api_key"}',
    );
    expect(readAuth(sqlite, "vellum")).toBe("{}");
  });

  test("skips unparseable auth", () => {
    const { sqlite, db } = createTestDb();
    insertRow(sqlite, "broken", "openai", "not json");

    migrateStripStoredAuthType(db);

    expect(readAuth(sqlite, "broken")).toBe("not json");
  });

  test("is idempotent", () => {
    const { sqlite, db } = createTestDb();
    insertRow(
      sqlite,
      "anthropic-personal",
      "anthropic",
      '{"type":"api_key","credential":"vault/anthropic"}',
    );

    migrateStripStoredAuthType(db);
    const afterFirst = readAuth(sqlite, "anthropic-personal");
    migrateStripStoredAuthType(db);

    expect(readAuth(sqlite, "anthropic-personal")).toBe(afterFirst);
    expect(JSON.parse(afterFirst!)).toEqual({ credential: "vault/anthropic" });
  });

  test("no-ops without the table", () => {
    const bare = new Database(":memory:");
    expect(() =>
      migrateStripStoredAuthType(drizzle(bare, { schema })),
    ).not.toThrow();
  });
});
