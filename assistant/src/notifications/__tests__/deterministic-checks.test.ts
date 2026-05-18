/**
 * Tests for the deterministic pre-send checks.
 *
 * Focus: the rendered-copy quality check that suppresses notifications
 * with empty bodies or bodies that leak the raw source event name
 * (the `buildGenericCopy` fallback path).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { notificationEvents } from "../../memory/schema.js";
import {
  type DeterministicCheckContext,
  runDeterministicChecks,
} from "../deterministic-checks.js";
import type { NotificationSignal } from "../signal.js";
import type { NotificationDecision } from "../types.js";

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
    sourceContextId: "ctx-1",
    sourceEventName: "schedule.notify",
    contextPayload: {},
    attentionHints: {
      requiresAction: false,
      urgency: "low",
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
    reasoningSummary: "test",
    renderedCopy: {
      vellum: { title: "Reminder", body: "Time to drink water" },
    },
    dedupeKey: `dk-${crypto.randomUUID()}`,
    confidence: 0.9,
    fallbackUsed: false,
    ...overrides,
  };
}

const context: DeterministicCheckContext = {
  connectedChannels: ["vellum"],
};

describe("checkRenderedCopyQuality (via runDeterministicChecks)", () => {
  test("passes when body is real non-empty text", async () => {
    const result = await runDeterministicChecks(
      makeSignal(),
      makeDecision(),
      context,
    );
    expect(result.passed).toBe(true);
  });

  test("fails when body is empty", async () => {
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Reminder", body: "" },
      },
    });
    const result = await runDeterministicChecks(
      makeSignal(),
      decision,
      context,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("empty");
  });

  test("fails when body is whitespace only", async () => {
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Reminder", body: "   \n  " },
      },
    });
    const result = await runDeterministicChecks(
      makeSignal(),
      decision,
      context,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("empty");
  });

  test("fails when body is the raw source event name", async () => {
    const signal = makeSignal({ sourceEventName: "user.send_notification" });
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Reminder", body: "user.send_notification" },
      },
    });
    const result = await runDeterministicChecks(signal, decision, context);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("fallback leak");
  });

  test("fails when body matches the normalized source event name", async () => {
    const signal = makeSignal({ sourceEventName: "user.send_notification" });
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Reminder", body: "user send notification" },
      },
    });
    const result = await runDeterministicChecks(signal, decision, context);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("fallback leak");
  });

  test("fails when rendered copy is missing for a selected channel", async () => {
    const decision = makeDecision({
      selectedChannels: ["vellum"],
      renderedCopy: {},
    });
    const result = await runDeterministicChecks(
      makeSignal(),
      decision,
      context,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("rendered copy missing");
    expect(result.reason).toContain("vellum");
  });

  test("passes when shouldNotify is false regardless of copy contents", async () => {
    const signal = makeSignal({ sourceEventName: "user.send_notification" });
    const decision = makeDecision({
      shouldNotify: false,
      // Empty body + event-name body would both fail the copy check if
      // shouldNotify were true. Short-circuit must skip the check.
      renderedCopy: {
        vellum: { title: "", body: "" },
      },
    });
    const result = await runDeterministicChecks(signal, decision, context);
    expect(result.passed).toBe(true);
  });
});
