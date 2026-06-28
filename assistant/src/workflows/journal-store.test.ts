import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb, getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { migrateWorkflowRuns } from "../persistence/migrations/284-workflow-runs.js";
import {
  appendJournalEntry,
  createRun,
  finishRun,
  getJournal,
  getRun,
  listRuns,
  pruneRuns,
  updateRun,
} from "./journal-store.js";

await initializeDb();

const DAY_MS = 24 * 60 * 60 * 1000;

function resetTables(): void {
  getSqlite().exec("DELETE FROM workflow_journal");
  getSqlite().exec("DELETE FROM workflow_runs");
}

describe("workflow journal store", () => {
  beforeEach(() => {
    resetTables();
  });

  test("the migration is idempotent (re-running is a no-op)", () => {
    // initializeDb (called at module load) already ran the migration once.
    // Running it directly a second and third time must not throw and must
    // leave the tables intact and usable.
    expect(() => migrateWorkflowRuns(getDb())).not.toThrow();
    expect(() => migrateWorkflowRuns(getDb())).not.toThrow();

    createRun({
      id: "wf-idem",
      scriptSource: "console.log(1)",
      scriptHash: "h1",
    });
    expect(getRun("wf-idem")?.id).toBe("wf-idem");
  });

  test("createRun round-trips all fields with sane defaults", () => {
    const run = createRun({
      id: "wf-1",
      name: "nightly digest",
      scriptSource: "await agent('x')",
      scriptHash: "hash-abc",
      args: { topic: "ai" },
      capabilities: ["search", "email"],
      conversationId: "conv-xyz",
      trust: { sourceChannel: "slack", trustClass: "unknown" },
    });

    expect(run).toMatchObject({
      id: "wf-1",
      name: "nightly digest",
      scriptSource: "await agent('x')",
      scriptHash: "hash-abc",
      args: { topic: "ai" },
      capabilities: ["search", "email"],
      status: "running",
      conversationId: "conv-xyz",
      trust: { sourceChannel: "slack", trustClass: "unknown" },
      agentsSpawned: 0,
      inputTokens: 0,
      outputTokens: 0,
      result: null,
      error: null,
      finishedAt: null,
    });
    expect(run.createdAt).toBeGreaterThan(0);
    expect(run.updatedAt).toBeGreaterThan(0);

    expect(getRun("wf-1")).toEqual(run);
  });

  test("optional fields default to null", () => {
    const run = createRun({
      id: "wf-min",
      scriptSource: "noop",
      scriptHash: "h",
    });
    expect(run).toMatchObject({
      name: null,
      args: null,
      capabilities: null,
      conversationId: null,
      trust: null,
    });
  });

  test("updateRun patches only provided fields and bumps updated_at", () => {
    const created = createRun({
      id: "wf-2",
      scriptSource: "s",
      scriptHash: "h",
    });

    const updated = updateRun("wf-2", {
      status: "running",
      agentsSpawned: 3,
      inputTokens: 100,
      outputTokens: 50,
      conversationId: "conv-new",
    });

    expect(updated).toMatchObject({
      agentsSpawned: 3,
      inputTokens: 100,
      outputTokens: 50,
      conversationId: "conv-new",
      // Untouched fields preserved.
      scriptSource: "s",
      scriptHash: "h",
    });
    expect(updated!.updatedAt!).toBeGreaterThanOrEqual(created.updatedAt!);
  });

  test("updateRun returns null for an unknown run", () => {
    expect(updateRun("nope", { status: "failed" })).toBeNull();
  });

  test("finishRun stamps terminal status, result, and finished_at", () => {
    createRun({ id: "wf-3", scriptSource: "s", scriptHash: "h" });

    const finished = finishRun("wf-3", {
      status: "completed",
      result: { ok: true, count: 2 },
    });

    expect(finished).toMatchObject({
      status: "completed",
      result: { ok: true, count: 2 },
      error: null,
    });
    expect(finished!.finishedAt).toBeGreaterThan(0);
  });

  test("finishRun records failure error text", () => {
    createRun({ id: "wf-fail", scriptSource: "s", scriptHash: "h" });
    const finished = finishRun("wf-fail", {
      status: "failed",
      error: "boom",
    });
    expect(finished).toMatchObject({ status: "failed", error: "boom" });
  });

  test("appendJournalEntry + getJournal round-trips in seq order", () => {
    createRun({ id: "wf-j", scriptSource: "s", scriptHash: "h" });

    appendJournalEntry({
      runId: "wf-j",
      seq: 1,
      callHash: "c1",
      kind: "agent",
      request: { prompt: "a" },
      result: { text: "ra" },
      status: "completed",
    });
    appendJournalEntry({
      runId: "wf-j",
      seq: 0,
      callHash: "c0",
      kind: "agent",
      request: { prompt: "b" },
      result: 123,
      status: "completed",
    });

    const journal = getJournal("wf-j");
    expect(journal.map((e) => e.seq)).toEqual([0, 1]);
    expect(journal[0]).toMatchObject({
      runId: "wf-j",
      seq: 0,
      callHash: "c0",
      kind: "agent",
      request: { prompt: "b" },
      result: 123,
      status: "completed",
    });
    expect(journal[1]).toMatchObject({
      kind: "agent",
      request: { prompt: "a" },
      result: { text: "ra" },
    });
  });

  test("appendJournalEntry round-trips per-leaf token usage", () => {
    createRun({ id: "wf-tok", scriptSource: "s", scriptHash: "h" });

    appendJournalEntry({
      runId: "wf-tok",
      seq: 0,
      callHash: "c0",
      kind: "agent",
      request: { prompt: "with tokens" },
      result: { text: "r" },
      status: "completed",
      inputTokens: 120,
      outputTokens: 45,
    });
    // A leaf with no recorded usage stores NULL → reads back as undefined.
    appendJournalEntry({
      runId: "wf-tok",
      seq: 1,
      callHash: "c1",
      kind: "agent",
      request: { prompt: "no tokens" },
      result: { error: "boom" },
      status: "failed",
    });

    const journal = getJournal("wf-tok");
    expect(journal[0]).toMatchObject({
      seq: 0,
      inputTokens: 120,
      outputTokens: 45,
    });
    expect(journal[1].inputTokens).toBeUndefined();
    expect(journal[1].outputTokens).toBeUndefined();
  });

  test("appendJournalEntry upserts token usage on a changed-hash re-run", () => {
    createRun({ id: "wf-tok-resume", scriptSource: "s", scriptHash: "h" });

    appendJournalEntry({
      runId: "wf-tok-resume",
      seq: 0,
      callHash: "hash-old",
      kind: "agent",
      result: { text: "old" },
      status: "completed",
      inputTokens: 10,
      outputTokens: 5,
    });
    // Resume re-runs the leaf with new usage; the upsert overwrites the tokens.
    appendJournalEntry({
      runId: "wf-tok-resume",
      seq: 0,
      callHash: "hash-new",
      kind: "agent",
      result: { text: "new" },
      status: "completed",
      inputTokens: 30,
      outputTokens: 12,
    });

    const journal = getJournal("wf-tok-resume");
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      seq: 0,
      callHash: "hash-new",
      inputTokens: 30,
      outputTokens: 12,
    });
  });

  test("appendJournalEntry is idempotent on (run_id, seq)", () => {
    createRun({ id: "wf-dup", scriptSource: "s", scriptHash: "h" });

    appendJournalEntry({
      runId: "wf-dup",
      seq: 0,
      callHash: "c0",
      kind: "agent",
      status: "completed",
    });
    // Replayed append for the same seq must not double-insert.
    appendJournalEntry({
      runId: "wf-dup",
      seq: 0,
      callHash: "c0",
      kind: "agent",
      status: "completed",
    });

    expect(getJournal("wf-dup")).toHaveLength(1);
  });

  test("appendJournalEntry upserts a changed-hash re-run at the same seq", () => {
    createRun({ id: "wf-resume", scriptSource: "s", scriptHash: "h" });

    // First run: leaf at seq 0 produces one (hash, result).
    appendJournalEntry({
      runId: "wf-resume",
      seq: 0,
      callHash: "hash-old",
      kind: "agent",
      request: { prompt: "old" },
      result: { text: "old-result" },
      status: "completed",
    });

    // Resume: the leaf's input CHANGED, so it re-runs and re-appends a new
    // (hash, result) at the SAME seq. The stale row must be overwritten.
    appendJournalEntry({
      runId: "wf-resume",
      seq: 0,
      callHash: "hash-new",
      kind: "agent",
      request: { prompt: "new" },
      result: { text: "new-result" },
      status: "completed",
    });

    const journal = getJournal("wf-resume");
    // Still exactly one row at seq 0 (no duplicate).
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      seq: 0,
      callHash: "hash-new",
      request: { prompt: "new" },
      result: { text: "new-result" },
      status: "completed",
    });
  });

  test("listRuns returns newest-first and honors limit + status filter", () => {
    // created_at is wall-clock; force distinct ordering via direct timestamps.
    createRun({ id: "old", scriptSource: "s", scriptHash: "h" });
    getSqlite().exec(
      "UPDATE workflow_runs SET created_at = 1000 WHERE id = 'old'",
    );
    createRun({ id: "mid", scriptSource: "s", scriptHash: "h" });
    getSqlite().exec(
      "UPDATE workflow_runs SET created_at = 2000 WHERE id = 'mid'",
    );
    createRun({ id: "new", scriptSource: "s", scriptHash: "h" });
    getSqlite().exec(
      "UPDATE workflow_runs SET created_at = 3000 WHERE id = 'new'",
    );
    finishRun("new", { status: "completed" });

    expect(listRuns({ limit: 10 }).map((r) => r.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect(listRuns({ limit: 1 }).map((r) => r.id)).toEqual(["new"]);
    expect(
      listRuns({ limit: 10, status: "completed" }).map((r) => r.id),
    ).toEqual(["new"]);
  });

  test("pruneRuns deletes finished runs past retention but keeps running ones", () => {
    const now = Date.now();

    // Old finished run — should be pruned.
    createRun({ id: "old-done", scriptSource: "s", scriptHash: "h" });
    finishRun("old-done", { status: "completed" });
    appendJournalEntry({
      runId: "old-done",
      seq: 0,
      callHash: "c",
      kind: "agent",
      status: "completed",
    });
    getSqlite().exec(
      `UPDATE workflow_runs SET created_at = ${now - 10 * DAY_MS} WHERE id = 'old-done'`,
    );

    // Old but still running — must be kept.
    createRun({ id: "old-running", scriptSource: "s", scriptHash: "h" });
    getSqlite().exec(
      `UPDATE workflow_runs SET created_at = ${now - 10 * DAY_MS} WHERE id = 'old-running'`,
    );

    // Recent finished run — within retention, kept.
    createRun({ id: "recent-done", scriptSource: "s", scriptHash: "h" });
    finishRun("recent-done", { status: "completed" });

    const deleted = pruneRuns(7);
    expect(deleted).toBe(1);
    expect(getRun("old-done")).toBeNull();
    expect(getJournal("old-done")).toHaveLength(0);
    expect(getRun("old-running")).not.toBeNull();
    expect(getRun("recent-done")).not.toBeNull();
  });

  test("pruneRuns never reaps a resumable 'interrupted' run, even past retention", () => {
    const now = Date.now();

    // Old interrupted run (crash-orphaned, awaiting resume) with a journal —
    // pruning it would destroy resumability, so it MUST be kept.
    createRun({ id: "old-interrupted", scriptSource: "s", scriptHash: "h" });
    updateRun("old-interrupted", { status: "interrupted" });
    appendJournalEntry({
      runId: "old-interrupted",
      seq: 0,
      callHash: "c",
      kind: "agent",
      status: "completed",
    });
    getSqlite().exec(
      `UPDATE workflow_runs SET created_at = ${now - 100 * DAY_MS} WHERE id = 'old-interrupted'`,
    );

    const deleted = pruneRuns(7);
    expect(deleted).toBe(0);
    expect(getRun("old-interrupted")).not.toBeNull();
    // Its journal survives too, so resume can still replay.
    expect(getJournal("old-interrupted")).toHaveLength(1);
  });

  test("pruneRuns reaps every TERMINAL status past retention", () => {
    const now = Date.now();
    const terminal = [
      "completed",
      "failed",
      "aborted",
      "cap_exceeded",
    ] as const;
    for (const status of terminal) {
      createRun({ id: `old-${status}`, scriptSource: "s", scriptHash: "h" });
      finishRun(`old-${status}`, { status });
      getSqlite().exec(
        `UPDATE workflow_runs SET created_at = ${now - 10 * DAY_MS} WHERE id = 'old-${status}'`,
      );
    }

    const deleted = pruneRuns(7);
    expect(deleted).toBe(terminal.length);
    for (const status of terminal) {
      expect(getRun(`old-${status}`)).toBeNull();
    }
  });
});
