import { beforeEach, describe, expect, test } from "bun:test";

import {
  MAX_RESUME_ATTEMPTS,
  reconcileInterruptedConversations,
} from "../daemon/interrupted-turn-reconciler.js";
import {
  createConversation,
  incrementProcessingResumeAttempts,
  listInterruptedConversations,
  setConversationProcessingStartedAt,
} from "../persistence/conversation-crud.js";
import { getDb, getSqliteFrom } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

function readRow(id: string): {
  processing_started_at: number | null;
  processing_resume_attempts: number;
} {
  const row = getSqliteFrom(getDb())
    .query(
      `SELECT processing_started_at, processing_resume_attempts
       FROM conversations WHERE id = ?`,
    )
    .get(id) as {
    processing_started_at: number | null;
    processing_resume_attempts: number;
  } | null;
  if (!row) {
    throw new Error(`conversation row missing: ${id}`);
  }
  return row;
}

function seedInterrupted(id: string, resumeAttempts = 0): void {
  createConversation({ id });
  setConversationProcessingStartedAt(id, Date.now());
  for (let i = 0; i < resumeAttempts; i++) {
    incrementProcessingResumeAttempts(id);
  }
}

describe("interrupted-turn reconciler", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM messages");
    getDb().run("DELETE FROM conversations");
  });

  test("resume disabled: clears every stale flag and resumes nothing", () => {
    seedInterrupted("conv-a");
    seedInterrupted("conv-b");
    createConversation({ id: "conv-idle" });

    const result = reconcileInterruptedConversations(false);

    expect(result.cleared).toBe(2);
    expect(result.resume).toEqual([]);
    expect(result.capped).toEqual([]);
    expect(readRow("conv-a").processing_started_at).toBeNull();
    expect(readRow("conv-b").processing_started_at).toBeNull();
    expect(readRow("conv-a").processing_resume_attempts).toBe(0);
  });

  test("resume enabled: clears flags, selects interrupted conversations, and charges an attempt", () => {
    seedInterrupted("conv-a");
    createConversation({ id: "conv-idle" });

    const result = reconcileInterruptedConversations(true);

    expect(result.cleared).toBe(1);
    expect(result.resume).toEqual(["conv-a"]);
    expect(result.capped).toEqual([]);
    expect(readRow("conv-a").processing_started_at).toBeNull();
    expect(readRow("conv-a").processing_resume_attempts).toBe(1);
    expect(readRow("conv-idle").processing_resume_attempts).toBe(0);
  });

  test("conversations at the attempt cap are cleared but not resumed", () => {
    seedInterrupted("conv-fresh");
    seedInterrupted("conv-capped", MAX_RESUME_ATTEMPTS);

    const result = reconcileInterruptedConversations(true);

    expect(result.cleared).toBe(2);
    expect(result.resume).toEqual(["conv-fresh"]);
    expect(result.capped).toEqual(["conv-capped"]);
    expect(readRow("conv-capped").processing_started_at).toBeNull();
    expect(readRow("conv-capped").processing_resume_attempts).toBe(
      MAX_RESUME_ATTEMPTS,
    );
  });

  test("attempt counter survives the flag clear so the cap holds across boots", () => {
    seedInterrupted("conv-a");

    expect(reconcileInterruptedConversations(true).resume).toEqual(["conv-a"]);
    // Simulate the resumed turn dying mid-flight on the next boot.
    setConversationProcessingStartedAt("conv-a", Date.now());
    expect(reconcileInterruptedConversations(true).resume).toEqual(["conv-a"]);
    setConversationProcessingStartedAt("conv-a", Date.now());

    const third = reconcileInterruptedConversations(true);
    expect(third.resume).toEqual([]);
    expect(third.capped).toEqual(["conv-a"]);
  });

  test("a clean turn end resets the attempt counter", () => {
    seedInterrupted("conv-a", 1);

    setConversationProcessingStartedAt("conv-a", null);

    expect(readRow("conv-a").processing_resume_attempts).toBe(0);
    expect(listInterruptedConversations()).toEqual([]);
  });

  test("listInterruptedConversations reports only flagged conversations with their attempts", () => {
    seedInterrupted("conv-a", 1);
    createConversation({ id: "conv-idle" });

    expect(listInterruptedConversations()).toEqual([
      { id: "conv-a", resumeAttempts: 1 },
    ]);
  });
});
