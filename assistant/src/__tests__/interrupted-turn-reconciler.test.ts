import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  type InterruptedResumeTarget,
  MAX_RESUME_ATTEMPTS,
  reconcileInterruptedConversations,
  resumeInterruptedConversations,
} from "../daemon/interrupted-turn-reconciler.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../daemon/trust-context.js";
import {
  createConversation,
  incrementProcessingResumeAttempts,
  listInterruptedConversations,
  setConversationOriginChannelIfUnset,
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

/** A local conversation (no origin channel) resumes under guardian trust. */
function guardianTarget(conversationId: string): InterruptedResumeTarget {
  return { conversationId, trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT };
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
    expect(result.trustUnrecoverable).toEqual([]);
    expect(readRow("conv-a").processing_started_at).toBeNull();
    expect(readRow("conv-b").processing_started_at).toBeNull();
    expect(readRow("conv-a").processing_resume_attempts).toBe(0);
  });

  test("resume enabled: clears flags and selects local conversations under guardian trust", () => {
    seedInterrupted("conv-a");
    createConversation({ id: "conv-idle" });

    const result = reconcileInterruptedConversations(true);

    expect(result.cleared).toBe(1);
    expect(result.resume).toEqual([guardianTarget("conv-a")]);
    expect(result.capped).toEqual([]);
    expect(result.trustUnrecoverable).toEqual([]);
    expect(readRow("conv-a").processing_started_at).toBeNull();
    // Selection no longer charges the attempt — that happens as each wake
    // starts, so a crash mid-resume can't burn un-attempted budgets.
    expect(readRow("conv-a").processing_resume_attempts).toBe(0);
    expect(readRow("conv-idle").processing_resume_attempts).toBe(0);
  });

  test("the internal vellum channel is treated as a guardian-owned local conversation", () => {
    seedInterrupted("conv-vellum");
    setConversationOriginChannelIfUnset("conv-vellum", "vellum");

    const result = reconcileInterruptedConversations(true);

    expect(result.resume).toEqual([guardianTarget("conv-vellum")]);
    expect(result.trustUnrecoverable).toEqual([]);
  });

  test("remote-channel conversations are cleared but skipped when trust can't be recovered", () => {
    seedInterrupted("conv-remote");
    setConversationOriginChannelIfUnset("conv-remote", "telegram");
    seedInterrupted("conv-local");

    const result = reconcileInterruptedConversations(true);

    expect(result.cleared).toBe(2);
    expect(result.resume).toEqual([guardianTarget("conv-local")]);
    expect(result.capped).toEqual([]);
    expect(result.trustUnrecoverable).toEqual(["conv-remote"]);
    expect(readRow("conv-remote").processing_started_at).toBeNull();
    // A skipped conversation is never charged an attempt.
    expect(readRow("conv-remote").processing_resume_attempts).toBe(0);
  });

  test("conversations at the attempt cap are cleared but not resumed", () => {
    seedInterrupted("conv-fresh");
    seedInterrupted("conv-capped", MAX_RESUME_ATTEMPTS);

    const result = reconcileInterruptedConversations(true);

    expect(result.cleared).toBe(2);
    expect(result.resume).toEqual([guardianTarget("conv-fresh")]);
    expect(result.capped).toEqual(["conv-capped"]);
    expect(result.trustUnrecoverable).toEqual([]);
    expect(readRow("conv-capped").processing_started_at).toBeNull();
    expect(readRow("conv-capped").processing_resume_attempts).toBe(
      MAX_RESUME_ATTEMPTS,
    );
  });

  test("attempts charged at wake start make the cap hold across boots", () => {
    seedInterrupted("conv-a");

    // Boot 1: selected for resume; the wake charges the attempt, then the
    // resumed turn dies mid-flight and re-sets the processing flag.
    expect(reconcileInterruptedConversations(true).resume).toEqual([
      guardianTarget("conv-a"),
    ]);
    incrementProcessingResumeAttempts("conv-a");
    setConversationProcessingStartedAt("conv-a", Date.now());

    // Boot 2: same again.
    expect(reconcileInterruptedConversations(true).resume).toEqual([
      guardianTarget("conv-a"),
    ]);
    incrementProcessingResumeAttempts("conv-a");
    setConversationProcessingStartedAt("conv-a", Date.now());

    // Boot 3: the counter reached the cap, so the flag is cleared but no
    // resume is selected.
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

describe("resumeInterruptedConversations", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM messages");
    getDb().run("DELETE FROM conversations");
  });

  test("charges each attempt only as its own wake begins and threads trust", async () => {
    createConversation({ id: "conv-a" });
    createConversation({ id: "conv-b" });

    // Snapshot both counters at the instant each conversation's wake runs, so
    // we can prove a conversation still queued behind another has not been
    // charged yet — a crash mid-resume must not burn its budget.
    const attemptsWhenWoken: Record<string, { a: number; b: number }> = {};
    const wakeCalls: Array<Record<string, unknown>> = [];
    const wakeMock = mock(async (opts: Record<string, unknown>) => {
      const conversationId = opts.conversationId as string;
      attemptsWhenWoken[conversationId] = {
        a: readRow("conv-a").processing_resume_attempts,
        b: readRow("conv-b").processing_resume_attempts,
      };
      wakeCalls.push(opts);
      return { invoked: true, producedToolCalls: false };
    });
    mock.module("../runtime/agent-wake.js", () => ({
      wakeAgentForOpportunity: wakeMock,
    }));

    await resumeInterruptedConversations([
      guardianTarget("conv-a"),
      guardianTarget("conv-b"),
    ]);

    // conv-a is charged before its own wake; conv-b is still at 0 while conv-a
    // runs, and is charged only when its own wake begins.
    expect(attemptsWhenWoken["conv-a"]).toEqual({ a: 1, b: 0 });
    expect(attemptsWhenWoken["conv-b"]).toEqual({ a: 1, b: 1 });
    expect(readRow("conv-a").processing_resume_attempts).toBe(1);
    expect(readRow("conv-b").processing_resume_attempts).toBe(1);

    expect(wakeCalls).toHaveLength(2);
    expect(wakeCalls[0]).toMatchObject({
      conversationId: "conv-a",
      source: "interrupted-turn-resume",
      trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
      clientless: true,
      persistTriggerAsEvent: true,
    });
  });

  test("a failing wake still charges its own attempt and continues to the next", async () => {
    createConversation({ id: "conv-bad" });
    createConversation({ id: "conv-good" });

    const wakeCalls: string[] = [];
    const wakeMock = mock(async (opts: Record<string, unknown>) => {
      const conversationId = opts.conversationId as string;
      wakeCalls.push(conversationId);
      if (conversationId === "conv-bad") {
        throw new Error("wake blew up");
      }
      return { invoked: true, producedToolCalls: false };
    });
    mock.module("../runtime/agent-wake.js", () => ({
      wakeAgentForOpportunity: wakeMock,
    }));

    await resumeInterruptedConversations([
      guardianTarget("conv-bad"),
      guardianTarget("conv-good"),
    ]);

    // The bad conversation was attempted (so it was charged), and the failure
    // did not block the remaining conversation.
    expect(wakeCalls).toEqual(["conv-bad", "conv-good"]);
    expect(readRow("conv-bad").processing_resume_attempts).toBe(1);
    expect(readRow("conv-good").processing_resume_attempts).toBe(1);
  });
});
