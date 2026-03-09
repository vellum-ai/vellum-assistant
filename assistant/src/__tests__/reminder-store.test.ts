import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "reminder-store-test-"));
process.env.BASE_DATA_DIR = testDir;

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { reminders } from "../memory/schema.js";
import {
  cancelReminder,
  claimDueReminders,
  completeReminder,
  failReminder,
  getReminder,
  insertReminder,
  listReminders,
  setReminderConversationId,
} from "../tools/reminder/reminder-store.js";

initializeDb();

function clearReminders() {
  getDb().delete(reminders).run();
}

afterAll(() => {
  resetDb();
  rmSync(testDir, { recursive: true, force: true });
});

describe("reminder-store", () => {
  beforeEach(() => {
    clearReminders();
  });

  // ── insertReminder ──────────────────────────────────────────────────

  test("insertReminder creates a row and returns it with correct fields", () => {
    const r = insertReminder({
      label: "Call Sidd",
      message: "Remember to call Sidd about the project",
      fireAt: Date.now() + 60_000,
      mode: "notify",
    });

    expect(r.id).toBeTruthy();
    expect(r.label).toBe("Call Sidd");
    expect(r.message).toBe("Remember to call Sidd about the project");
    expect(r.mode).toBe("notify");
    expect(r.status).toBe("pending");
    expect(r.firedAt).toBeNull();
    expect(r.conversationId).toBeNull();
    expect(r.routingIntent).toBe("all_channels");
    expect(r.routingHints).toEqual({});
    expect(r.createdAt).toBeGreaterThan(0);
    expect(r.updatedAt).toBeGreaterThan(0);
  });

  test("insertReminder persists routing metadata", () => {
    const r = insertReminder({
      label: "Multi-channel",
      message: "Deliver everywhere",
      fireAt: Date.now() + 60_000,
      mode: "notify",
      routingIntent: "all_channels",
      routingHints: { preferred: ["telegram", "slack"] },
    });

    expect(r.routingIntent).toBe("all_channels");
    expect(r.routingHints).toEqual({ preferred: ["telegram", "slack"] });

    const fetched = getReminder(r.id);
    expect(fetched!.routingIntent).toBe("all_channels");
    expect(fetched!.routingHints).toEqual({ preferred: ["telegram", "slack"] });
  });

  test("insertReminder defaults routingIntent to all_channels when omitted", () => {
    const r = insertReminder({
      label: "No routing",
      message: "Should default",
      fireAt: Date.now() + 60_000,
      mode: "notify",
    });

    expect(r.routingIntent).toBe("all_channels");
    expect(r.routingHints).toEqual({});

    const fetched = getReminder(r.id);
    expect(fetched!.routingIntent).toBe("all_channels");
    expect(fetched!.routingHints).toEqual({});
  });

  // ── getReminder ─────────────────────────────────────────────────────

  test("getReminder returns null for nonexistent ID", () => {
    expect(getReminder("nonexistent")).toBeNull();
  });

  test("getReminder returns the inserted reminder", () => {
    const r = insertReminder({
      label: "Test",
      message: "Test message",
      fireAt: Date.now() + 60_000,
      mode: "execute",
    });

    const fetched = getReminder(r.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(r.id);
    expect(fetched!.mode).toBe("execute");
  });

  // ── listReminders ──────────────────────────────────────────────────

  test("listReminders returns all reminders with routing metadata", () => {
    insertReminder({
      label: "A",
      message: "a",
      fireAt: Date.now() + 60_000,
      mode: "notify",
    });
    insertReminder({
      label: "B",
      message: "b",
      fireAt: Date.now() + 120_000,
      mode: "execute",
      routingIntent: "multi_channel",
    });

    const all = listReminders();
    expect(all).toHaveLength(2);
    expect(all[0].routingIntent).toBe("all_channels");
    expect(all[1].routingIntent).toBe("multi_channel");
  });

  test("listReminders with pendingOnly filters to pending only", () => {
    const r = insertReminder({
      label: "A",
      message: "a",
      fireAt: Date.now() + 60_000,
      mode: "notify",
    });
    insertReminder({
      label: "B",
      message: "b",
      fireAt: Date.now() + 120_000,
      mode: "notify",
    });

    // Cancel one
    cancelReminder(r.id);

    const pending = listReminders({ pendingOnly: true });
    expect(pending).toHaveLength(1);
    expect(pending[0].label).toBe("B");

    const all = listReminders();
    expect(all).toHaveLength(2);
  });

  // ── cancelReminder ──────────────────────────────────────────────────

  test("cancelReminder sets status to cancelled and returns true", () => {
    const r = insertReminder({
      label: "Cancel me",
      message: "x",
      fireAt: Date.now() + 60_000,
      mode: "notify",
    });
    expect(cancelReminder(r.id)).toBe(true);

    const fetched = getReminder(r.id);
    expect(fetched!.status).toBe("cancelled");
  });

  test("cancelReminder returns false for nonexistent ID", () => {
    expect(cancelReminder("nonexistent")).toBe(false);
  });

  test("cancelReminder returns false for already-fired reminder", () => {
    const r = insertReminder({
      label: "Fire me",
      message: "x",
      fireAt: Date.now() - 1000,
      mode: "notify",
    });

    // Fire it first
    claimDueReminders(Date.now());

    expect(cancelReminder(r.id)).toBe(false);
  });

  // ── claimDueReminders ──────────────────────────────────────────────

  test("claimDueReminders claims reminders where fireAt <= now and preserves routing", () => {
    const now = Date.now();
    insertReminder({
      label: "Past",
      message: "x",
      fireAt: now - 5000,
      mode: "notify",
      routingIntent: "all_channels",
      routingHints: { foo: "bar" },
    });
    insertReminder({
      label: "Future",
      message: "y",
      fireAt: now + 60_000,
      mode: "notify",
    });

    const claimed = claimDueReminders(now);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].label).toBe("Past");
    expect(claimed[0].status).toBe("firing");
    expect(claimed[0].firedAt).toBe(now);
    expect(claimed[0].routingIntent).toBe("all_channels");
    expect(claimed[0].routingHints).toEqual({ foo: "bar" });
  });

  test("claimDueReminders skips already-fired reminders", () => {
    const now = Date.now();
    insertReminder({
      label: "Past",
      message: "x",
      fireAt: now - 5000,
      mode: "notify",
    });

    // Claim once
    const first = claimDueReminders(now);
    expect(first).toHaveLength(1);

    // Claim again — should get nothing
    const second = claimDueReminders(now);
    expect(second).toHaveLength(0);
  });

  test("claimDueReminders skips cancelled reminders", () => {
    const now = Date.now();
    const r = insertReminder({
      label: "Cancel me",
      message: "x",
      fireAt: now - 5000,
      mode: "notify",
    });
    cancelReminder(r.id);

    const claimed = claimDueReminders(now);
    expect(claimed).toHaveLength(0);
  });

  test("claimDueReminders optimistic locking prevents double-claiming", () => {
    const now = Date.now();
    insertReminder({
      label: "Once only",
      message: "x",
      fireAt: now - 1000,
      mode: "notify",
    });

    // Two simultaneous claims
    const first = claimDueReminders(now);
    const second = claimDueReminders(now);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  // ── completeReminder ─────────────────────────────────────────────

  test("completeReminder transitions firing to fired", () => {
    const now = Date.now();
    const r = insertReminder({
      label: "Complete me",
      message: "x",
      fireAt: now - 1000,
      mode: "notify",
    });

    claimDueReminders(now);
    expect(getReminder(r.id)!.status).toBe("firing");

    completeReminder(r.id);
    expect(getReminder(r.id)!.status).toBe("fired");
  });

  // ── failReminder ────────────────────────────────────────────────

  test("failReminder reverts firing back to pending", () => {
    const now = Date.now();
    const r = insertReminder({
      label: "Fail me",
      message: "x",
      fireAt: now - 1000,
      mode: "execute",
    });

    claimDueReminders(now);
    expect(getReminder(r.id)!.status).toBe("firing");

    failReminder(r.id);

    const fetched = getReminder(r.id)!;
    expect(fetched.status).toBe("pending");
    expect(fetched.firedAt).toBeNull();
  });

  test("failReminder allows the reminder to be reclaimed", () => {
    const now = Date.now();
    const r = insertReminder({
      label: "Retry me",
      message: "x",
      fireAt: now - 1000,
      mode: "execute",
    });

    // Claim, then fail
    claimDueReminders(now);
    failReminder(r.id);

    // Should be claimable again
    const reclaimed = claimDueReminders(now);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].id).toBe(r.id);
  });

  // ── setReminderConversationId ──────────────────────────────────────

  test("setReminderConversationId updates the conversation ID on a fired reminder", () => {
    const now = Date.now();
    const r = insertReminder({
      label: "Exec me",
      message: "x",
      fireAt: now - 1000,
      mode: "execute",
    });

    claimDueReminders(now);

    setReminderConversationId(r.id, "conv-123");

    const fetched = getReminder(r.id);
    expect(fetched!.conversationId).toBe("conv-123");
  });
});
