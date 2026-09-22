/**
 * Tests for `hasNotifiedSourceContextSince`, the probe the schedule-result
 * producer uses to ask "did this run already notify?".
 *
 * Two things are worth pinning down. The `since` bound: a recurring schedule
 * with `reuseConversation` runs every firing in the same conversation, so an
 * unbounded probe would find run #1's notification forever and silence every
 * run after it. And the outcome test: `emitNotificationSignal` persists the
 * event before the pipeline can fail, so an event row alone proves an attempt,
 * not a notification — counting it would suppress the fallback in exactly the
 * case it exists for.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { createDecision } from "../notifications/decisions-store.js";
import { createDelivery } from "../notifications/deliveries-store.js";
import {
  createEvent,
  hasNotifiedSourceContextSince,
} from "../notifications/events-store.js";
import type { NotificationDeliveryStatus } from "../notifications/types.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  notificationDecisions,
  notificationDeliveries,
  notificationEvents,
} from "../persistence/schema/index.js";

await initializeDb();

const CONVERSATION_ID = "conv-schedule-run";

beforeEach(() => {
  getDb().delete(notificationDeliveries).run();
  getDb().delete(notificationDecisions).run();
  getDb().delete(notificationEvents).run();
});

/**
 * How far the seeded signal got through the pipeline.
 *
 * - `no-verdict`: the event row exists and nothing else — the pipeline threw
 *   before the decision stage.
 * - `declined`: the engine decided not to notify.
 * - a delivery status: the engine said notify and dispatch recorded a delivery
 *   in that state.
 */
type SeedOutcome = "no-verdict" | "declined" | NotificationDeliveryStatus;

/**
 * Seed a signal and backdate its event: `createEvent` stamps `Date.now()`, but
 * the `since` cases turn entirely on where a row sits relative to a run's start.
 */
function seedSignalAt(
  sourceContextId: string,
  createdAt: number,
  outcome: SeedOutcome = "sent",
): void {
  const eventId = crypto.randomUUID();
  createEvent({
    id: eventId,
    sourceEventName: "assistant.share",
    sourceChannel: "assistant_tool",
    sourceContextId,
    attentionHints: {
      requiresAction: false,
      urgency: "low",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    payload: { requestedMessage: "sent by the run itself" },
  });
  getDb()
    .update(notificationEvents)
    .set({ createdAt })
    .where(eq(notificationEvents.id, eventId))
    .run();

  if (outcome === "no-verdict") {
    return;
  }
  const decision = createDecision({
    id: crypto.randomUUID(),
    notificationEventId: eventId,
    shouldNotify: outcome !== "declined",
    selectedChannels: outcome === "declined" ? [] : ["vellum"],
    reasoningSummary: "test",
    confidence: 1,
    fallbackUsed: false,
  });
  if (outcome === "declined") {
    return;
  }
  createDelivery({
    id: crypto.randomUUID(),
    notificationDecisionId: decision.id,
    channel: "vellum",
    destination: "vellum",
    status: outcome,
    attempt: 1,
  });
}

describe("hasNotifiedSourceContextSince", () => {
  const runStartedAt = 1_700_000_000_000;

  describe("the since bound", () => {
    test("finds a notification sent during the run", () => {
      seedSignalAt(CONVERSATION_ID, runStartedAt + 500);

      expect(hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
        true,
      );
    });

    test("ignores a notification from a prior run in the same conversation", () => {
      // The reused-conversation case: yesterday's firing notified, today's did
      // not. Today's run still owes the user a notification.
      const todaysRunStartedAt = runStartedAt + 86_400_000;
      seedSignalAt(CONVERSATION_ID, runStartedAt + 500);

      expect(
        hasNotifiedSourceContextSince(CONVERSATION_ID, todaysRunStartedAt),
      ).toBe(false);
    });

    test("counts a notification landing exactly at the run's start", () => {
      // The bound is inclusive: a notification stamped in the same millisecond
      // the run began belongs to that run.
      seedSignalAt(CONVERSATION_ID, runStartedAt);

      expect(hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
        true,
      );
    });

    test("ignores a notification from a different conversation", () => {
      seedSignalAt("some-other-conversation", runStartedAt + 500);

      expect(hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
        false,
      );
    });

    test("returns false when nothing was ever emitted", () => {
      expect(hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
        false,
      );
    });
  });

  describe("the outcome test", () => {
    test("ignores an event whose pipeline never reached a verdict", () => {
      // The audit row of an emit that threw before the decision stage. Nobody
      // was told, so the run still owes its notification.
      seedSignalAt(CONVERSATION_ID, runStartedAt + 500, "no-verdict");

      expect(hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
        false,
      );
    });

    test("ignores an event whose only delivery failed", () => {
      seedSignalAt(CONVERSATION_ID, runStartedAt + 500, "failed");

      expect(hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
        false,
      );
    });

    test("ignores an event whose only delivery was skipped", () => {
      seedSignalAt(CONVERSATION_ID, runStartedAt + 500, "skipped");

      expect(hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
        false,
      );
    });

    test("counts a delivery still pending", () => {
      // Something is on its way; the fallback must not race it.
      seedSignalAt(CONVERSATION_ID, runStartedAt + 500, "pending");

      expect(hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
        true,
      );
    });

    test("counts a decision not to notify", () => {
      // The engine ruled on the run's own signal. The fallback covers runs that
      // never asked; it does not appeal verdicts the user's settings produced.
      seedSignalAt(CONVERSATION_ID, runStartedAt + 500, "declined");

      expect(hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
        true,
      );
    });

    test("one delivered signal among failed ones is enough", () => {
      seedSignalAt(CONVERSATION_ID, runStartedAt + 100, "failed");
      seedSignalAt(CONVERSATION_ID, runStartedAt + 200, "sent");

      expect(hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt)).toBe(
        true,
      );
    });
  });
});
