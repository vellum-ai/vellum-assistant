import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateChatgptSubscriptionRowIdentity } from "./366-chatgpt-subscription-row-identity.js";

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

function readProvider(sqlite: Database, name: string): string | undefined {
  const row = sqlite
    .query(`SELECT provider FROM provider_connections WHERE name = ?`)
    .get(name) as { provider: string } | null;
  return row?.provider;
}

describe("migration 366: chatgpt-subscription row identity", () => {
  test("flips the subscription row to provider chatgpt", () => {
    const { sqlite, db } = createTestDb();
    insertRow(
      sqlite,
      "chatgpt-subscription",
      "openai",
      '{"type":"oauth_subscription","credential":"credential/chatgpt/access_token"}',
    );

    migrateChatgptSubscriptionRowIdentity(db);

    expect(readProvider(sqlite, "chatgpt-subscription")).toBe("chatgpt");
  });

  test("leaves a claiming row with key auth untouched", () => {
    const { sqlite, db } = createTestDb();
    insertRow(
      sqlite,
      "chatgpt-subscription",
      "openai",
      '{"type":"api_key","credential":"vault/openai"}',
    );

    migrateChatgptSubscriptionRowIdentity(db);

    expect(readProvider(sqlite, "chatgpt-subscription")).toBe("openai");
  });

  test("leaves other rows untouched", () => {
    const { sqlite, db } = createTestDb();
    insertRow(sqlite, "openai-key", "openai", '{"type":"api_key"}');
    insertRow(sqlite, "vellum", "vellum", '{"type":"platform"}');

    migrateChatgptSubscriptionRowIdentity(db);

    expect(readProvider(sqlite, "openai-key")).toBe("openai");
    expect(readProvider(sqlite, "vellum")).toBe("vellum");
  });

  test("leaves unparseable auth untouched", () => {
    const { sqlite, db } = createTestDb();
    insertRow(sqlite, "chatgpt-subscription", "openai", "not json");

    migrateChatgptSubscriptionRowIdentity(db);

    expect(readProvider(sqlite, "chatgpt-subscription")).toBe("openai");
  });

  test("is idempotent", () => {
    const { sqlite, db } = createTestDb();
    insertRow(
      sqlite,
      "chatgpt-subscription",
      "openai",
      '{"type":"oauth_subscription"}',
    );

    migrateChatgptSubscriptionRowIdentity(db);
    migrateChatgptSubscriptionRowIdentity(db);

    expect(readProvider(sqlite, "chatgpt-subscription")).toBe("chatgpt");
  });

  test("no-ops without the table or the row", () => {
    const bare = new Database(":memory:");
    expect(() =>
      migrateChatgptSubscriptionRowIdentity(drizzle(bare, { schema })),
    ).not.toThrow();

    const { db } = createTestDb();
    expect(() => migrateChatgptSubscriptionRowIdentity(db)).not.toThrow();
  });
});
