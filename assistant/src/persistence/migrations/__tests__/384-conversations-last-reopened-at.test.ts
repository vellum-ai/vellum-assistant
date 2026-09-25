import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../../schema/index.js";
import { migrateConversationsLastReopenedAt } from "../384-conversations-last-reopened-at.js";

test("adds a nullable reopen marker without changing existing chats and is idempotent", () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(
      "CREATE TABLE conversations (id TEXT PRIMARY KEY, archived_at INTEGER)",
    );
    sqlite.exec("INSERT INTO conversations VALUES ('conv-123', 123)");
    const db = drizzle(sqlite, { schema });
    migrateConversationsLastReopenedAt(db);
    migrateConversationsLastReopenedAt(db);
    expect(sqlite.query("SELECT * FROM conversations").get()).toEqual({
      id: "conv-123",
      archived_at: 123,
      last_reopened_at: null,
    });
    sqlite.exec("UPDATE conversations SET last_reopened_at = 456");
    migrateConversationsLastReopenedAt(db);
    expect(
      sqlite.query("SELECT last_reopened_at FROM conversations").get(),
    ).toEqual({ last_reopened_at: 456 });
  } finally {
    sqlite.close();
  }
});
