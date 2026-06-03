import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  createConversation,
  forkConversation,
  getConversation,
} from "../conversation-crud.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { messages } from "../schema.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
}

describe("createConversation incognito fields", () => {
  beforeEach(() => {
    resetTables();
  });

  test("persists explicit incognito and factorInMemories opts", () => {
    const { id } = createConversation({
      incognito: true,
      factorInMemories: false,
    });

    const row = getConversation(id);
    expect(row).not.toBeNull();
    expect(row?.incognito).toBe(1);
    expect(row?.factorInMemories).toBe(0);
  });

  test("defaults incognito off and factorInMemories on", () => {
    const { id } = createConversation({ title: "Default" });

    const row = getConversation(id);
    expect(row).not.toBeNull();
    expect(row?.incognito).toBe(0);
    expect(row?.factorInMemories).toBe(1);
  });
});

describe("forkConversation inherits incognito state", () => {
  beforeEach(() => {
    resetTables();
  });

  function seedMessage(conversationId: string): void {
    getDb()
      .insert(messages)
      .values({
        id: `msg-${conversationId}`,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "fork me" }]),
        createdAt: Date.now(),
      })
      .run();
  }

  test("forking an incognito conversation yields an incognito fork", () => {
    const { id } = createConversation({
      incognito: true,
      factorInMemories: false,
    });
    seedMessage(id);

    const fork = forkConversation({ conversationId: id });

    expect(fork.incognito).toBe(1);
    expect(fork.factorInMemories).toBe(0);
  });

  test("forking a normal conversation yields a normal fork", () => {
    const { id } = createConversation({ incognito: false });
    seedMessage(id);

    const fork = forkConversation({ conversationId: id });

    expect(fork.incognito).toBe(0);
    expect(fork.factorInMemories).toBe(1);
  });
});
