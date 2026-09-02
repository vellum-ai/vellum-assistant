/**
 * Two guarantees for the `schedule.notify` producer.
 *
 * 1. Recurring firings must not be deduplicated against prior firings of the
 *    same schedule. The scheduler supplies a unique per-firing dedupeKey
 *    (`schedule:notify:<id>:<timestamp>`) so `setEventDedupeKey` is never
 *    called for schedule signals and `checkDedupe` never finds a matching
 *    row when the LLM decision engine generates a stable key like
 *    `schedule:notify:<id>`.
 * 2. `visibleInSourceNow` is resolved from the schedule's originating
 *    conversation, so a reminder is not pushed into the conversation the user
 *    is already reading.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { runDeterministicChecks } from "../notifications/deterministic-checks.js";
import { createEvent } from "../notifications/events-store.js";
import type {
  AttentionHints,
  NotificationSignal,
} from "../notifications/signal.js";
import type { NotificationDecision } from "../notifications/types.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { notificationEvents } from "../persistence/schema/index.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

interface CapturedEmit {
  sourceEventName: string;
  attentionHints: AttentionHints;
  contextPayload: Record<string, unknown>;
}

const emitCalls: CapturedEmit[] = [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: CapturedEmit) => {
    emitCalls.push(params);
  },
}));

let webFocused = false;
let webPresenceShouldThrow = false;
const webPresenceArgs: unknown[][] = [];
const realWebPresence = await import("../runtime/web-presence.js");
mock.module("../runtime/web-presence.js", () => ({
  ...realWebPresence,
  isWebConversationFocused: (...args: unknown[]) => {
    webPresenceArgs.push(args);
    if (webPresenceShouldThrow) {
      throw new Error("simulated presence read failure");
    }
    return webFocused;
  },
}));

const { createSchedule } = await import("../schedule/schedule-store.js");
const { runDueSchedulesOnce } = await import("../schedule/scheduler.js");

const PRESENCE_FLAG = "activity-presence-suppression";
const SCHEDULE_CONVERSATION_ID = "conv-schedule-1";

await initializeDb();

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

describe("schedule.notify source-active suppression", () => {
  beforeEach(() => {
    emitCalls.length = 0;
    webFocused = false;
    webPresenceShouldThrow = false;
    webPresenceArgs.length = 0;
    setOverridesForTesting({ [PRESENCE_FLAG]: true });
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
  });

  async function fireDueNotifySchedule(
    createdFromConversationId: string | null,
  ): Promise<void> {
    await createSchedule({
      name: "Drink water",
      cronExpression: null,
      message: "ping",
      mode: "notify",
      nextRunAt: Date.now() - 1000,
      createdFromConversationId,
    });
    await runDueSchedulesOnce();
  }

  test("suppresses when the originating conversation is focused", async () => {
    webFocused = true;

    await fireDueNotifySchedule(SCHEDULE_CONVERSATION_ID);

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].sourceEventName).toBe("schedule.notify");
    expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(true);
    expect(emitCalls[0].attentionHints.urgency).toBe("high");
    expect(webPresenceArgs).toEqual([[SCHEDULE_CONVERSATION_ID]]);
  });

  test("notifies when the originating conversation is not focused", async () => {
    webFocused = false;

    await fireDueNotifySchedule(SCHEDULE_CONVERSATION_ID);

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
    expect(webPresenceArgs).toEqual([[SCHEDULE_CONVERSATION_ID]]);
  });

  test("never reads presence while the flag is off", async () => {
    webFocused = true;
    setOverridesForTesting({ [PRESENCE_FLAG]: false });

    await fireDueNotifySchedule(SCHEDULE_CONVERSATION_ID);

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
    expect(webPresenceArgs).toEqual([]);
  });

  test("fails open when the presence read throws", async () => {
    webPresenceShouldThrow = true;

    await fireDueNotifySchedule(SCHEDULE_CONVERSATION_ID);

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
  });

  test("a schedule with no originating conversation keeps notifying", async () => {
    webFocused = true;

    await fireDueNotifySchedule(null);

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].contextPayload.deepLinkConversationId).toBeUndefined();
    expect(emitCalls[0].attentionHints.visibleInSourceNow).toBe(false);
    expect(webPresenceArgs).toEqual([]);
  });
});
