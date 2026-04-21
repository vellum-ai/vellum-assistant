/**
 * Regression test: recurring `schedule.notify` firings must not be
 * deduplicated against prior firings of the same schedule.
 *
 * The scheduler supplies a unique per-firing dedupeKey
 * (`schedule:notify:<id>:<timestamp>`) so `updateEventDedupeKey` is never
 * called for schedule signals and `checkDedupe` never finds a matching
 * row when the LLM decision engine generates a stable key like
 * `schedule:notify:<id>`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

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
import { createEvent } from "../notifications/events-store.js";
import type { NotificationSignal } from "../notifications/signal.js";
import type { NotificationDecision } from "../notifications/types.js";

initializeDb();

beforeEach(() => {
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
    sourceEventName: "schedule.notify",
    contextPayload: { scheduleId: "schedule-123", label: "Drink water" },
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
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
    reasoningSummary: "Schedule reminder",
    renderedCopy: {
      vellum: { title: "Reminder", body: "Time to drink water" },
    },
    dedupeKey: "schedule:notify:schedule-123",
    confidence: 0.9,
    fallbackUsed: false,
    ...overrides,
  };
}

describe("recurring schedule.notify dedup", () => {
  test("notify mode with timestamped producer keys is not blocked", async () => {
    const stableKey = "schedule:notify:schedule-123";
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();

    const firstSignal = makeSignal({ signalId: firstId });
    createEvent({
      id: firstSignal.signalId,
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "schedule-123",
      attentionHints: firstSignal.attentionHints,
      payload: firstSignal.contextPayload,
      dedupeKey: `schedule:notify:schedule-123:${Date.now() - 60_000}`,
    });

    const secondSignal = makeSignal({ signalId: secondId });
    createEvent({
      id: secondSignal.signalId,
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "schedule-123",
      attentionHints: secondSignal.attentionHints,
      payload: secondSignal.contextPayload,
      dedupeKey: `schedule:notify:schedule-123:${Date.now()}`,
    });

    const decision = makeDecision({ dedupeKey: stableKey });

    const result = await runDeterministicChecks(secondSignal, decision, {
      connectedChannels: ["vellum"],
    });

    expect(result.passed).toBe(true);
  });
});
