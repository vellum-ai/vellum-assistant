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
  findAnalysisConversationFor,
  getConversationSource,
} from "../conversation-crud.js";
import { getDb, initializeDb } from "../db.js";
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

function setUpdatedAt(conversationId: string, updatedAt: number): void {
  const db = getDb();
  db.update(conversations)
    .set({ updatedAt })
    .where(eq(conversations.id, conversationId))
    .run();
}

describe("findAnalysisConversationFor", () => {
  beforeEach(() => {
    resetTables();
  });

  test("returns null when no analysis conversation exists for the parent", () => {
    const parent = createConversation("parent");
    expect(findAnalysisConversationFor(parent.id)).toBeNull();
  });

  test("returns null when an unrelated analysis conversation exists", () => {
    const parent = createConversation("parent");
    const other = createConversation("other");
    const analysisForOther = createConversation({
      title: "analysis of other",
      source: "auto-analysis",
    });
    setForkParent(analysisForOther.id, other.id);

    expect(findAnalysisConversationFor(parent.id)).toBeNull();
  });

  test("returns the only matching analysis conversation when one exists", () => {
    const parent = createConversation("parent");
    const analysis = createConversation({
      title: "rolling analysis",
      source: "auto-analysis",
    });
    setForkParent(analysis.id, parent.id);

    expect(findAnalysisConversationFor(parent.id)).toEqual({ id: analysis.id });
  });

  test("when multiple match, returns the most recently updated one", () => {
    const parent = createConversation("parent");

    const older = createConversation({
      title: "older analysis",
      source: "auto-analysis",
    });
    setForkParent(older.id, parent.id);
    setUpdatedAt(older.id, 1_000);

    const newer = createConversation({
      title: "newer analysis",
      source: "auto-analysis",
    });
    setForkParent(newer.id, parent.id);
    setUpdatedAt(newer.id, 2_000);

    const middle = createConversation({
      title: "middle analysis",
      source: "auto-analysis",
    });
    setForkParent(middle.id, parent.id);
    setUpdatedAt(middle.id, 1_500);

    expect(findAnalysisConversationFor(parent.id)).toEqual({ id: newer.id });
  });

  test("does not return regular user conversations whose forkParentConversationId matches", () => {
    const parent = createConversation("parent");

    // A regular user-forked conversation (source defaults to "user").
    const userFork = createConversation("user fork");
    setForkParent(userFork.id, parent.id);

    expect(findAnalysisConversationFor(parent.id)).toBeNull();
  });

  test("ignores user forks even when an analysis conversation also exists", () => {
    const parent = createConversation("parent");

    const userFork = createConversation("user fork");
    setForkParent(userFork.id, parent.id);
    // Force the user fork to have the most recent updatedAt — it should
    // still be ignored because its source is "user".
    setUpdatedAt(userFork.id, 9_999);

    const analysis = createConversation({
      title: "analysis",
      source: "auto-analysis",
    });
    setForkParent(analysis.id, parent.id);
    setUpdatedAt(analysis.id, 1_000);

    expect(findAnalysisConversationFor(parent.id)).toEqual({ id: analysis.id });
  });

  test("createConversation persists forkParentConversationId when supplied", () => {
    const parent = createConversation("parent");

    // Auto-analyze path creates the rolling analysis conversation with
    // source + forkParentConversationId in the same call.
    const analysis = createConversation({
      title: "rolling analysis",
      source: "auto-analysis",
      forkParentConversationId: parent.id,
    });

    expect(findAnalysisConversationFor(parent.id)).toEqual({ id: analysis.id });
  });

  test("finds rolling analysis conversation regardless of group_id (backward-compat across the dedicated-group migration)", () => {
    const parent = createConversation("parent");

    const legacyAnalysis = createConversation({
      title: "legacy rolling analysis",
      source: "auto-analysis",
      forkParentConversationId: parent.id,
    });
    setUpdatedAt(legacyAnalysis.id, 1_000);

    expect(findAnalysisConversationFor(parent.id)).toEqual({
      id: legacyAnalysis.id,
    });

    const newAnalysis = createConversation({
      title: "new rolling analysis",
      source: "auto-analysis",
      groupId: "system:background",
      forkParentConversationId: parent.id,
    });
    setUpdatedAt(newAnalysis.id, 2_000);

    expect(findAnalysisConversationFor(parent.id)).toEqual({
      id: newAnalysis.id,
    });
  });
});

describe("getConversationSource", () => {
  beforeEach(() => {
    resetTables();
  });

  test("returns the source string for an existing conversation", () => {
    const conv = createConversation("user conv");
    expect(getConversationSource(conv.id)).toBe("user");
  });

  test("returns the custom source for an analysis conversation", () => {
    const conv = createConversation({
      title: "analysis",
      source: "auto-analysis",
    });
    expect(getConversationSource(conv.id)).toBe("auto-analysis");
  });

  test("returns null for a non-existent conversation ID", () => {
    expect(getConversationSource("does-not-exist")).toBeNull();
  });
});
