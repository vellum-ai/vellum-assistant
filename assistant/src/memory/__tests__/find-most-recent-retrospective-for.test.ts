import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  createConversation,
  findMostRecentRetrospectiveFor,
} from "../conversation-crud.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { MEMORY_RETROSPECTIVE_SOURCE } from "../memory-retrospective-constants.js";
import { conversations } from "../schema.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
}

function setForkParent(conversationId: string, parentId: string): void {
  const db = getDb();
  db.update(conversations)
    .set({ forkParentConversationId: parentId })
    .where(eq(conversations.id, conversationId))
    .run();
}

function setCreatedAt(conversationId: string, createdAt: number): void {
  const db = getDb();
  db.update(conversations)
    .set({ createdAt })
    .where(eq(conversations.id, conversationId))
    .run();
}

function createRetro(parentId: string, createdAt: number): { id: string } {
  const retro = createConversation({
    title: "retro",
    source: MEMORY_RETROSPECTIVE_SOURCE,
  });
  setForkParent(retro.id, parentId);
  setCreatedAt(retro.id, createdAt);
  return { id: retro.id };
}

describe("findMostRecentRetrospectiveFor", () => {
  beforeEach(() => {
    resetTables();
  });

  test("returns null when no retrospective exists anywhere in the fork chain", () => {
    const conv = createConversation("conv");
    expect(findMostRecentRetrospectiveFor(conv.id)).toBeNull();
  });

  test("returns a direct retrospective rooted at the conversation", () => {
    const conv = createConversation("conv");
    const retro = createRetro(conv.id, 1_000);

    expect(findMostRecentRetrospectiveFor(conv.id)).toEqual({
      id: retro.id,
      forkParentConversationId: conv.id,
    });
  });

  test("returns the most recently created retrospective when multiple exist at the same level", () => {
    const conv = createConversation("conv");
    createRetro(conv.id, 1_000);
    const newer = createRetro(conv.id, 2_000);
    createRetro(conv.id, 500);

    expect(findMostRecentRetrospectiveFor(conv.id)).toEqual({
      id: newer.id,
      forkParentConversationId: conv.id,
    });
  });

  test("walks up the fork chain when the current conversation has no retros", () => {
    const parent = createConversation("parent");
    const parentRetro = createRetro(parent.id, 1_000);

    const fork = createConversation("fork");
    setForkParent(fork.id, parent.id);

    expect(findMostRecentRetrospectiveFor(fork.id)).toEqual({
      id: parentRetro.id,
      // Owned by the PARENT — callers must not GC it on the fork's behalf.
      forkParentConversationId: parent.id,
    });
  });

  test("prefers the fork's own retros over the parent's", () => {
    const parent = createConversation("parent");
    createRetro(parent.id, 5_000);

    const fork = createConversation("fork");
    setForkParent(fork.id, parent.id);
    const forkRetro = createRetro(fork.id, 1_000);

    expect(findMostRecentRetrospectiveFor(fork.id)).toEqual({
      id: forkRetro.id,
      forkParentConversationId: fork.id,
    });
  });

  test("walks multiple levels (fork-of-fork) until it finds a retro", () => {
    const grandparent = createConversation("grandparent");
    const grandparentRetro = createRetro(grandparent.id, 1_000);

    const parent = createConversation("parent");
    setForkParent(parent.id, grandparent.id);

    const fork = createConversation("fork");
    setForkParent(fork.id, parent.id);

    expect(findMostRecentRetrospectiveFor(fork.id)).toEqual({
      id: grandparentRetro.id,
      forkParentConversationId: grandparent.id,
    });
  });

  test("returns null when the entire fork chain has no retros", () => {
    const grandparent = createConversation("grandparent");
    const parent = createConversation("parent");
    setForkParent(parent.id, grandparent.id);
    const fork = createConversation("fork");
    setForkParent(fork.id, parent.id);

    expect(findMostRecentRetrospectiveFor(fork.id)).toBeNull();
  });
});
