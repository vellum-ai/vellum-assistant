import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  createConversation,
  getConversation,
} from "../conversation-crud.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";

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
