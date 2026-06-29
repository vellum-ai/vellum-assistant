import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";

import { addMessage, getMessages } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations } from "../persistence/schema.js";

await initializeDb();

function ensureConversation(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: "test",
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    })
    .onConflictDoNothing()
    .run();
}

describe("addMessage pre-assigned id", () => {
  beforeEach(() => {
    ensureConversation("conv-preassigned-id");
  });

  test("uses the provided id as the persisted row id", async () => {
    const customId = randomUUID();
    const result = await addMessage("conv-preassigned-id", "user", "hello", {
      id: customId,
    });

    expect(result.id).toBe(customId);
    expect(result.deduplicated).toBe(false);

    const msgs = getMessages("conv-preassigned-id");
    const found = msgs.find((m) => m.id === customId);
    expect(found).toBeDefined();
    expect(found?.content).toBe("hello");
  });

  test("generates a uuid when no id is provided", async () => {
    const result = await addMessage("conv-preassigned-id", "user", "world");

    expect(result.id).toBeTruthy();
    expect(result.deduplicated).toBe(false);
    // Should be a UUID-like string (36 chars with hyphens)
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
