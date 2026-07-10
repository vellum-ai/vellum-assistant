/**
 * Tests that the conversations import route never persists non-renderable
 * roles. The messages store is UI-facing (`ConversationMessage`), so an
 * imported export carrying agent-context `system` rows must land only its
 * `user`/`assistant` turns — the `system` rows are dropped, not persisted.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

mock.module("../plugins/defaults/memory/indexer.js", () => ({
  indexMessageNow: async () => {},
}));

import { getMessages } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations, messages } from "../persistence/schema/index.js";
import { ROUTES } from "../runtime/routes/conversations-import-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM conversations");
}

const importHandler = ROUTES.find(
  (r) => r.operationId === "conversations_import",
)!.handler;

describe("conversations import system-row filtering", () => {
  beforeEach(resetTables);

  test("imports renderable turns but drops system rows", async () => {
    // GIVEN an export whose conversation sandwiches a system row between two
    // renderable turns (e.g. agent-context scaffolding an export carried)
    const body = {
      conversations: [
        {
          sourceKey: "src-1",
          title: "Imported chat",
          messages: [
            { role: "user", content: "first visible" },
            { role: "system", content: "agent-context scaffolding" },
            { role: "assistant", content: "second visible" },
          ],
        },
      ],
    };

    // WHEN the conversation is imported
    const result = (await importHandler({
      body,
    } as unknown as RouteHandlerArgs)) as {
      ok: boolean;
      imported: number;
      messages: number;
    };

    // THEN the import succeeds and only counts the renderable turns
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(1);
    expect(result.messages).toBe(2);

    // AND the persisted rows are exactly the user/assistant turns, never the
    // system scaffolding
    const db = getDb();
    const conv = db.select().from(conversations).all()[0];
    const rows = getMessages(conv.id);
    expect(rows.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(
      db
        .select()
        .from(messages)
        .all()
        .some((m) => m.role === "system"),
    ).toBe(false);
  });
});
