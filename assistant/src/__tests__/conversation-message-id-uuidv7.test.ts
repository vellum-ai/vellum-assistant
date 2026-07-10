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

import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

/** The UUID version nibble is the first hex digit of the third dash group. */
function uuidVersion(id: string): string {
  return id.split("-")[2]?.[0] ?? "";
}

describe("conversation & message ids use UUIDv7", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  test("server-generated conversation ids are v7 and monotonic", () => {
    const ids = Array.from(
      { length: 5 },
      (_, i) => createConversation({ title: `c${i}` }).id,
    );

    for (const id of ids) {
      expect(uuidVersion(id)).toBe("7");
    }
    // Time-ordered: ids sort in creation order (this is the append property).
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("server-generated message ids are v7", async () => {
    const conv = createConversation({ title: "messages" });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await addMessage(conv.id, "assistant", `m${i}`, {
        skipIndexing: true,
      });
      ids.push(m.id);
    }

    for (const id of ids) {
      expect(uuidVersion(id)).toBe("7");
    }
    expect([...ids].sort()).toEqual(ids);
  });

  test("an explicitly supplied message id is still adopted verbatim", async () => {
    const conv = createConversation({ title: "adopt" });
    const requestId = "11111111-2222-4333-8444-555555555555"; // a v4-shaped id
    const m = await addMessage(conv.id, "user", "hi", {
      id: requestId,
      skipIndexing: true,
    });
    expect(m.id).toBe(requestId);
  });
});
