/**
 * Tests for migration 347 — deleting the leaked ephemeral `greeting`
 * conversations row from the sidebar.
 *
 * A message-less `greeting` row is an ephemeral empty-state greeting persisted
 * by mistake and is removed; a `greeting` row carrying messages means the user
 * chatted in it and is preserved as user data. Unrelated conversations are
 * never touched, and the migration is idempotent.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite } = await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { migrateDeleteStrayGreetingConversation } =
  await import("../347-delete-stray-greeting-conversation.js");

await initializeDb();

function reset(): void {
  const db = getSqlite();
  db.query(`DELETE FROM messages`).run();
  db.query(`DELETE FROM conversations`).run();
}

function insertConversation(id: string): void {
  getSqlite()
    .query(
      `INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)`,
    )
    .run(id, Date.now(), Date.now());
}

let seq = 0;
function insertMessage(conversationId: string): void {
  getSqlite()
    .query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(`m347-${seq++}`, conversationId, "user", "hello", Date.now());
}

function conversationExists(id: string): boolean {
  return (
    getSqlite()
      .query(`SELECT 1 AS present FROM conversations WHERE id = ?`)
      .get(id) != null
  );
}

describe("migration 347 — delete stray greeting conversation", () => {
  test("deletes an empty greeting row", () => {
    reset();
    insertConversation("greeting");

    migrateDeleteStrayGreetingConversation(getDb());

    expect(conversationExists("greeting")).toBe(false);
  });

  test("preserves a greeting row that carries messages", () => {
    reset();
    insertConversation("greeting");
    insertMessage("greeting");

    migrateDeleteStrayGreetingConversation(getDb());

    expect(conversationExists("greeting")).toBe(true);
  });

  test("never touches unrelated conversations", () => {
    reset();
    insertConversation("greeting");
    insertConversation("real-conversation");

    migrateDeleteStrayGreetingConversation(getDb());

    expect(conversationExists("greeting")).toBe(false);
    expect(conversationExists("real-conversation")).toBe(true);
  });

  test("is idempotent across repeated runs", () => {
    reset();
    insertConversation("greeting");

    migrateDeleteStrayGreetingConversation(getDb());
    // A second run finds no matching row and must not throw.
    migrateDeleteStrayGreetingConversation(getDb());

    expect(conversationExists("greeting")).toBe(false);
  });

  test("no-ops cleanly when there is no greeting row at all", () => {
    reset();
    insertConversation("real-conversation");

    migrateDeleteStrayGreetingConversation(getDb());

    expect(conversationExists("real-conversation")).toBe(true);
  });
});
