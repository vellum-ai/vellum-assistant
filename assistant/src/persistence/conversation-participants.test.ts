import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  addParticipant,
  isParticipant,
  listConversationIdsForPrincipal,
  removeParticipant,
} from "./conversation-participants.js";
import { migrateCreateConversationParticipants } from "./migrations/384-create-conversation-participants.js";
import * as schema from "./schema.js";

function createStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/* sql */ `
    PRAGMA foreign_keys = ON;
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    INSERT INTO conversations (id) VALUES ('conv-1'), ('conv-2');
  `);
  const db = drizzle(sqlite, { schema });
  migrateCreateConversationParticipants(db);

  function rows(conversationId: string) {
    return sqlite
      .prepare(
        `SELECT principal_id, role, removed_at
           FROM conversation_participants
          WHERE conversation_id = ?`,
      )
      .all(conversationId) as {
      principal_id: string;
      role: string;
      removed_at: number | null;
    }[];
  }

  return { sqlite, rows, options: { db } };
}

describe("conversation participants store", () => {
  test("adds a participant and reports membership", () => {
    const { options } = createStore();

    const added = addParticipant(
      {
        conversationId: "conv-1",
        principalId: "principal-a",
        role: "creator",
        addedAt: 100,
      },
      options,
    );

    expect(added).toMatchObject({
      conversationId: "conv-1",
      principalId: "principal-a",
      role: "creator",
      addedBy: null,
      addedAt: 100,
      removedAt: null,
    });
    expect(isParticipant("conv-1", "principal-a", options)).toBe(true);
  });

  test("records who added a participant", () => {
    const { options } = createStore();

    const added = addParticipant(
      {
        conversationId: "conv-1",
        principalId: "principal-b",
        role: "participant",
        addedBy: "principal-a",
        addedAt: 200,
      },
      options,
    );

    expect(added.addedBy).toBe("principal-a");
  });

  test("a principal with no row is not a participant", () => {
    const { options } = createStore();

    expect(isParticipant("conv-1", "principal-z", options)).toBe(false);
  });

  test("removal ends membership but keeps the row", () => {
    const { rows, options } = createStore();
    addParticipant(
      {
        conversationId: "conv-1",
        principalId: "principal-a",
        role: "creator",
        addedAt: 100,
      },
      options,
    );

    expect(
      removeParticipant("conv-1", "principal-a", {
        ...options,
        removedAt: 500,
      }),
    ).toBe(true);

    expect(isParticipant("conv-1", "principal-a", options)).toBe(false);
    expect(rows("conv-1")).toEqual([
      { principal_id: "principal-a", role: "creator", removed_at: 500 },
    ]);
  });

  test("removing a principal who is not a live participant reports false", () => {
    const { options } = createStore();
    addParticipant(
      {
        conversationId: "conv-1",
        principalId: "principal-a",
        role: "creator",
        addedAt: 100,
      },
      options,
    );
    removeParticipant("conv-1", "principal-a", options);

    expect(removeParticipant("conv-1", "principal-a", options)).toBe(false);
    expect(removeParticipant("conv-1", "principal-z", options)).toBe(false);
  });

  test("re-adding a removed principal restores membership", () => {
    const { rows, options } = createStore();
    addParticipant(
      {
        conversationId: "conv-1",
        principalId: "principal-a",
        role: "creator",
        addedAt: 100,
      },
      options,
    );
    removeParticipant("conv-1", "principal-a", options);

    const readded = addParticipant(
      {
        conversationId: "conv-1",
        principalId: "principal-a",
        role: "participant",
        addedAt: 900,
      },
      options,
    );

    expect(readded).toMatchObject({
      role: "participant",
      addedAt: 900,
      removedAt: null,
    });
    expect(isParticipant("conv-1", "principal-a", options)).toBe(true);
    expect(rows("conv-1")).toHaveLength(1);
  });

  test("re-adding a live participant leaves the existing row alone", () => {
    const { rows, options } = createStore();
    addParticipant(
      {
        conversationId: "conv-1",
        principalId: "principal-a",
        role: "creator",
        addedBy: "principal-owner",
        addedAt: 100,
      },
      options,
    );

    const readded = addParticipant(
      {
        conversationId: "conv-1",
        principalId: "principal-a",
        role: "participant",
        addedBy: "principal-b",
        addedAt: 900,
      },
      options,
    );

    expect(readded).toMatchObject({
      role: "creator",
      addedBy: "principal-owner",
      addedAt: 100,
      removedAt: null,
    });
    expect(rows("conv-1")).toEqual([
      { principal_id: "principal-a", role: "creator", removed_at: null },
    ]);
  });

  test("lists only the conversations a principal is still in", () => {
    const { options } = createStore();
    addParticipant(
      {
        conversationId: "conv-1",
        principalId: "principal-a",
        role: "creator",
        addedAt: 100,
      },
      options,
    );
    addParticipant(
      {
        conversationId: "conv-2",
        principalId: "principal-a",
        role: "participant",
        addedAt: 200,
      },
      options,
    );
    addParticipant(
      {
        conversationId: "conv-1",
        principalId: "principal-b",
        role: "participant",
        addedAt: 300,
      },
      options,
    );

    expect(
      listConversationIdsForPrincipal("principal-a", options).sort(),
    ).toEqual(["conv-1", "conv-2"]);

    removeParticipant("conv-2", "principal-a", options);

    expect(listConversationIdsForPrincipal("principal-a", options)).toEqual([
      "conv-1",
    ]);
    expect(listConversationIdsForPrincipal("principal-b", options)).toEqual([
      "conv-1",
    ]);
    expect(listConversationIdsForPrincipal("principal-z", options)).toEqual([]);
  });

  test("deleting the conversation deletes its participants", () => {
    const { sqlite, rows, options } = createStore();
    addParticipant(
      {
        conversationId: "conv-1",
        principalId: "principal-a",
        role: "creator",
        addedAt: 100,
      },
      options,
    );

    sqlite.exec("DELETE FROM conversations WHERE id = 'conv-1'");

    expect(rows("conv-1")).toEqual([]);
    expect(isParticipant("conv-1", "principal-a", options)).toBe(false);
  });
});
