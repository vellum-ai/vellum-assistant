import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  AUTO_ANALYSIS_GROUP_ID,
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

describe("auto-analysis constants", () => {
  test("AUTO_ANALYSIS_SOURCE is the canonical 'auto-analysis' string", () => {
    expect(AUTO_ANALYSIS_SOURCE).toBe("auto-analysis");
  });

  test("AUTO_ANALYSIS_GROUP_ID is 'system:reflections' so rolling analysis conversations stay out of system:all", () => {
    expect(AUTO_ANALYSIS_GROUP_ID).toBe("system:reflections");
  });
});

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
