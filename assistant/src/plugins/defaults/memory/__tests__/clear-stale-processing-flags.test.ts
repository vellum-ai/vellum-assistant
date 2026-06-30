import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  clearStaleProcessingFlags,
  createConversation,
  isConversationProcessing,
  setConversationProcessingStartedAt,
} from "../../../../persistence/conversation-crud.js";
import { getDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
}

describe("clearStaleProcessingFlags", () => {
  beforeEach(() => {
    resetTables();
  });

  test("clears the processing flag on conversations left mid-turn", () => {
    const processing = createConversation("mid-turn");
    const idle = createConversation("idle");
    setConversationProcessingStartedAt(processing.id, Date.now());

    expect(isConversationProcessing(processing.id)).toBe(true);
    expect(isConversationProcessing(idle.id)).toBe(false);

    const cleared = clearStaleProcessingFlags();

    expect(cleared).toBe(1);
    expect(isConversationProcessing(processing.id)).toBe(false);
    expect(isConversationProcessing(idle.id)).toBe(false);
  });

  test("returns 0 when no conversation is processing", () => {
    createConversation("idle");

    expect(clearStaleProcessingFlags()).toBe(0);
  });
});
