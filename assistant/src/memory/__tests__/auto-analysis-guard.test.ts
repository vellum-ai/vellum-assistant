import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  AUTO_ANALYSIS_SOURCE,
  isAutoAnalysisConversation,
} from "../auto-analysis-guard.js";
import { createConversation } from "../conversation-crud.js";
import { getDb, initializeDb } from "../db.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
}

describe("isAutoAnalysisConversation", () => {
  beforeEach(() => {
    resetTables();
  });

  test("returns true for a conversation with source = 'auto-analysis'", () => {
    const conv = createConversation({
      title: "analysis",
      source: AUTO_ANALYSIS_SOURCE,
    });
    expect(isAutoAnalysisConversation(conv.id)).toBe(true);
  });

  test("returns false for a conversation with source = 'user'", () => {
    const conv = createConversation("regular user conversation");
    expect(isAutoAnalysisConversation(conv.id)).toBe(false);
  });

  test("returns false for a non-existent conversation", () => {
    expect(isAutoAnalysisConversation("does-not-exist")).toBe(false);
  });
});
