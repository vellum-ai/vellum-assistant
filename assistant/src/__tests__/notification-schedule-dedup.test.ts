/**
 * Regression test: recurring schedule notifications must not be
 * deduplicated against prior firings of the same schedule.
 *
 * Before the fix, `schedule.complete` signals were emitted without a
 * producer dedupeKey. The LLM decision engine would generate a stable
 * key (e.g. `schedule:complete:<id>`) and `updateEventDedupeKey` would
 * write it back to the event row. On the next firing, `checkDedupe`
 * found the first row's stable key within the 1-hour window and
 * silently blocked the notification.
 *
 * The fix: always supply a unique per-firing dedupeKey from the
 * producer so `updateEventDedupeKey` is never called for schedule
 * signals, and `checkDedupe` never finds a matching row.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(
  join(tmpdir(), "notification-schedule-dedup-test-"),
);

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

import { getDb, initializeDb } from "../memory/db.js";
import { notificationEvents } from "../memory/schema.js";
import { runDeterministicChecks } from "../notifications/deterministic-checks.js";
import {
  createEvent,
  updateEventDedupeKey,
} from "../notifications/events-store.js";
import type { NotificationSignal } from "../notifications/signal.js";
import type { NotificationDecision } from "../notifications/types.js";

initializeDb();

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  // Clear notification events between tests for isolation
  getDb().delete(notificationEvents).run();
});

function makeSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: `sig-${crypto.randomUUID()}`,
    createdAt: Date.now(),
    sourceChannel: "scheduler",
    sourceContextId: "schedule-123",
    sourceEventName: "schedule.complete",
    contextPayload: { scheduleId: "schedule-123", name: "Drink water" },
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

function makeDecision(
  overrides?: Partial<NotificationDecision>,
): NotificationDecision {
  return {
    shouldNotify: true,
    selectedChannels: ["vellum"],
    reasoningSummary: "Schedule completed",
    renderedCopy: {
      vellum: { title: "Reminder", body: "Time to drink water" },
    },
    dedupeKey: "schedule:complete:schedule-123",
    confidence: 0.9,
    fallbackUsed: false,
    ...overrides,
  };
}

describe("recurring schedule notification dedup", () => {
  test("second firing is blocked when LLM stable key is written to first event row (the bug)", async () => {
    // Simulate the BROKEN behavior: producer sends no dedupeKey,
    // LLM generates a stable key, and updateEventDedupeKey writes it
    // to the first event row.

    const stableKey = "schedule:complete:schedule-123";
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();

    // First firing: create event with null dedupeKey, then backfill with LLM key
    const firstSignal = makeSignal({ signalId: firstId });
    createEvent({
      id: firstSignal.signalId,
      sourceEventName: "schedule.complete",
      sourceChannel: "scheduler",
      sourceContextId: "schedule-123",
      attentionHints: firstSignal.attentionHints,
      payload: firstSignal.contextPayload,
      // No dedupeKey — this is the bug scenario
    });
    // LLM decision generates a stable key, pipeline writes it back
    updateEventDedupeKey(firstSignal.signalId, stableKey);

    // Second firing: new event, same schedule
    const secondSignal = makeSignal({ signalId: secondId });
    createEvent({
      id: secondSignal.signalId,
      sourceEventName: "schedule.complete",
      sourceChannel: "scheduler",
      sourceContextId: "schedule-123",
      attentionHints: secondSignal.attentionHints,
      payload: secondSignal.contextPayload,
    });

    // LLM generates the same stable key for the second firing
    const decision = makeDecision({ dedupeKey: stableKey });

    const result = await runDeterministicChecks(secondSignal, decision, {
      connectedChannels: ["vellum"],
    });

    // The second firing is BLOCKED — this is the bug
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Dedupe");
  });

  test("second firing passes when producer supplies unique per-firing dedupeKey (the fix)", async () => {
    const stableKey = "schedule:complete:schedule-123";
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();

    // First firing: producer supplies a timestamped dedupeKey
    const firstSignal = makeSignal({ signalId: firstId });
    createEvent({
      id: firstSignal.signalId,
      sourceEventName: "schedule.complete",
      sourceChannel: "scheduler",
      sourceContextId: "schedule-123",
      attentionHints: firstSignal.attentionHints,
      payload: firstSignal.contextPayload,
      dedupeKey: `schedule:complete:schedule-123:${Date.now() - 60_000}`,
    });
    // updateEventDedupeKey is NOT called because params.dedupeKey is truthy

    // Second firing: new event with its own unique timestamped key
    const secondSignal = makeSignal({ signalId: secondId });
    createEvent({
      id: secondSignal.signalId,
      sourceEventName: "schedule.complete",
      sourceChannel: "scheduler",
      sourceContextId: "schedule-123",
      attentionHints: secondSignal.attentionHints,
      payload: secondSignal.contextPayload,
      dedupeKey: `schedule:complete:schedule-123:${Date.now()}`,
    });

    // LLM still generates a stable key — but no row in the DB has it
    const decision = makeDecision({ dedupeKey: stableKey });

    const result = await runDeterministicChecks(secondSignal, decision, {
      connectedChannels: ["vellum"],
    });

    // The second firing PASSES — the fix works
    expect(result.passed).toBe(true);
  });

  test("notify mode with timestamped producer keys is not blocked", async () => {
    const stableKey = "schedule:notify:schedule-123";
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();

    // First firing
    const firstSignal = makeSignal({
      signalId: firstId,
      sourceEventName: "schedule.notify",
    });
    createEvent({
      id: firstSignal.signalId,
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "schedule-123",
      attentionHints: firstSignal.attentionHints,
      payload: firstSignal.contextPayload,
      dedupeKey: `schedule:notify:schedule-123:${Date.now() - 60_000}`,
    });

    // Second firing
    const secondSignal = makeSignal({
      signalId: secondId,
      sourceEventName: "schedule.notify",
    });
    createEvent({
      id: secondSignal.signalId,
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "schedule-123",
      attentionHints: secondSignal.attentionHints,
      payload: secondSignal.contextPayload,
      dedupeKey: `schedule:notify:schedule-123:${Date.now()}`,
    });

    // LLM generates stable key — no matching row
    const decision = makeDecision({ dedupeKey: stableKey });

    const result = await runDeterministicChecks(secondSignal, decision, {
      connectedChannels: ["vellum"],
    });

    expect(result.passed).toBe(true);
  });
});
