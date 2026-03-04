import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "reminder-test-"));
process.env.BASE_DATA_DIR = testDir;

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { reminders } from "../memory/schema.js";
import {
  executeReminderCancel,
  executeReminderCreate,
  executeReminderList,
} from "../tools/reminder/reminder.js";
import { claimDueReminders } from "../tools/reminder/reminder-store.js";

initializeDb();

function clearReminders() {
  getDb().delete(reminders).run();
}

afterAll(() => {
  resetDb();
  rmSync(testDir, { recursive: true, force: true });
});

describe("reminder tool", () => {
  beforeEach(() => {
    clearReminders();
  });

  // ── create ──────────────────────────────────────────────────────────

  test("create with valid future ISO timestamp succeeds", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: "Call Sidd",
      message: "Remember to call Sidd",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Reminder created");
    expect(result.content).toContain("Call Sidd");
    expect(result.content).toContain("notify");
  });

  test("create with past timestamp returns error", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: past,
      label: "Too late",
      message: "This is in the past",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("must be in the future");
  });

  test("create with invalid timestamp string returns error", async () => {
    const result = executeReminderCreate({
      fire_at: "not-a-date",
      label: "Bad date",
      message: "This has a bad date",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid timestamp");
  });

  test("create rejects non-ISO date formats like MM/DD/YYYY", async () => {
    const result = executeReminderCreate({
      fire_at: "03/04/2027",
      label: "Ambiguous date",
      message: "This format is locale-dependent",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid timestamp");
  });

  test("create rejects ISO timestamp without timezone", async () => {
    const result = executeReminderCreate({
      fire_at: "2027-03-15T09:00:00",
      label: "No timezone",
      message: "Missing timezone offset",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid timestamp");
  });

  test("create accepts ISO timestamp with timezone offset", async () => {
    const future = new Date(Date.now() + 120_000);
    const offset = "-05:00";
    const isoWithOffset = future.toISOString().replace("Z", offset);
    const result = executeReminderCreate({
      fire_at: isoWithOffset,
      label: "With offset",
      message: "Has explicit timezone",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Reminder created");
  });

  test("create defaults mode to notify", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: "Default mode",
      message: "Should be notify",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Mode: notify");
  });

  test("create with mode execute sets mode correctly", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: "Execute mode",
      message: "Should be execute",
      mode: "execute",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Mode: execute");
  });

  test("create requires fire_at", async () => {
    const result = executeReminderCreate({
      label: "No fire_at",
      message: "Missing fire_at",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("fire_at is required");
  });

  test("create requires label", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      message: "Missing label",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("label is required");
  });

  test("create requires message", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: "No message",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("message is required");
  });

  // ── routing ────────────────────────────────────────────────────────

  test("create defaults routing_intent to all_channels", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: "Default routing",
      message: "Should default to all_channels",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Routing: all_channels");
  });

  test("create with routing_intent all_channels succeeds", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: "All channels",
      message: "Deliver everywhere",
      routing_intent: "all_channels",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Routing: all_channels");
  });

  test("create with routing_intent multi_channel succeeds", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: "Multi channel",
      message: "Deliver to subset",
      routing_intent: "multi_channel",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Routing: multi_channel");
  });

  test("create with invalid routing_intent returns error", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: "Bad routing",
      message: "Invalid intent",
      routing_intent: "broadcast",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("routing_intent must be one of");
  });

  test("create with routing_hints object succeeds", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: "With hints",
      message: "Has routing hints",
      routing_intent: "multi_channel",
      routing_hints: { preferred: ["telegram"] },
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Routing: multi_channel");
  });

  test("create with routing_hints null returns error", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: "Bad hints",
      message: "Null hints should fail",
      routing_hints: null,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("routing_hints must be a JSON object");
  });

  test("create without routing fields still works (backward compat)", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = executeReminderCreate({
      fire_at: future,
      label: "No routing",
      message: "Legacy reminder",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Reminder created");
    expect(result.content).toContain("Routing: all_channels");
  });

  // ── list ────────────────────────────────────────────────────────────

  test('list returns "No reminders found" when empty', async () => {
    const result = executeReminderList();
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No reminders found");
  });

  test("list returns formatted reminders with routing", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    executeReminderCreate({
      fire_at: future,
      label: "Test reminder",
      message: "Test message",
      routing_intent: "all_channels",
    });

    const result = executeReminderList();
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Test reminder");
    expect(result.content).toContain("pending");
    expect(result.content).toContain("routing: all_channels");
  });

  // ── cancel ──────────────────────────────────────────────────────────

  test("cancel with valid pending reminder succeeds", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const createResult = executeReminderCreate({
      fire_at: future,
      label: "Cancel me",
      message: "To be cancelled",
    });

    // Extract ID from the create result
    const idMatch = createResult.content.match(/ID: (.+)/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1].trim();

    const result = executeReminderCancel({
      reminder_id: id,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("cancelled");
  });

  test("cancel with nonexistent ID returns error", async () => {
    const result = executeReminderCancel({
      reminder_id: "nonexistent",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  test("cancel with already-fired reminder returns error", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const createResult = executeReminderCreate({
      fire_at: future,
      label: "Fire then cancel",
      message: "x",
    });

    const idMatch = createResult.content.match(/ID: (.+)/);
    const id = idMatch![1].trim();

    // Force-fire by claiming with a future timestamp
    claimDueReminders(Date.now() + 120_000);

    const result = executeReminderCancel({
      reminder_id: id,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found or already fired");
  });
});
