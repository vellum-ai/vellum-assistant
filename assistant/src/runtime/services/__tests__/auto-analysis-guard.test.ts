import { beforeEach, describe, expect, test } from "bun:test";

import { AUTO_ANALYSIS_SOURCE } from "../../../persistence/auto-analysis-constants.js";
import { createConversation } from "../../../persistence/conversation-crud.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { isAutoAnalysisConversation } from "../auto-analysis-guard.js";
await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
}

describe("auto-analysis constants", () => {
  test("AUTO_ANALYSIS_SOURCE is the canonical 'auto-analysis' string", () => {
    expect(AUTO_ANALYSIS_SOURCE).toBe("auto-analysis");
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
