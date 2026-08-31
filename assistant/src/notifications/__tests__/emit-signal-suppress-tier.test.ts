/**
 * Regression tests for the pipeline-level attention-tier gate.
 *
 * A `suppress` tier means "do not surface at all", and `emitNotificationSignal`
 * drives more than one surface: channel dispatch is one, the home feed mirror
 * is another. The gate therefore sits in the pipeline, above both, rather than
 * inside the broadcaster -- a broadcaster-only gate stopped the channels and
 * still let the home feed publish a visible card.
 *
 * The gate runs after the decision stage, so a suppressed signal keeps its
 * full audit trail: the `notification_events` row and the
 * `notification_decisions` row both survive.
 *
 * The events store, the decisions store, their DB, and the deterministic
 * checks are the real ones; only the decision engine's judgment, the dispatch
 * step, the home-feed write, and the adapter graph around them are stubbed.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { NotificationSignal } from "../signal.js";
import type { NotificationDecision } from "../types.js";

const dispatchDecisionMock = mock();
const homeFeedWriteMock = mock();

mock.module("../../channels/config.js", () => ({
  getDeliverableChannels: () => ["vellum"],
}));

mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => [],
  guardianForChannel: () => undefined,
}));

mock.module("../../platform/client.js", () => ({
  VellumPlatformClient: class {
    static async create(): Promise<null> {
      return null;
    }
  },
  isPlatformClientConfigured: async () => false,
}));

mock.module("../broadcaster.js", () => ({
  NotificationBroadcaster: class {
    constructor(_adapters: unknown[]) {}
    setOnConversationCreated(_fn: unknown) {}
  },
}));

// The real decisions store, so the audit assertion below reads a row the
// production path would have written.
const { createDecision } = await import("../decisions-store.js");

const evaluateSignalMock = mock(
  async (signal: NotificationSignal): Promise<NotificationDecision> => {
    const persistedDecisionId = `decision-${signal.signalId}`;
    const decision: NotificationDecision = {
      shouldNotify: true,
      selectedChannels: ["vellum"],
      reasoningSummary: "deliver",
      renderedCopy: {
        vellum: { title: "Background job finished", body: "It finished." },
      },
      confidence: 0.9,
      fallbackUsed: false,
      // The deterministic checks reject a decision with no dedupe key, so the
      // control cases need one to reach dispatch at all.
      dedupeKey: "activity-completed:job-1",
      persistedDecisionId,
    };
    createDecision({
      id: persistedDecisionId,
      notificationEventId: signal.signalId,
      shouldNotify: decision.shouldNotify,
      selectedChannels: decision.selectedChannels,
      reasoningSummary: decision.reasoningSummary,
      confidence: decision.confidence,
      fallbackUsed: decision.fallbackUsed,
    });
    return decision;
  },
);

mock.module("../decision-engine.js", () => ({
  evaluateSignal: (signal: NotificationSignal) => evaluateSignalMock(signal),
  enforceRoutingIntent: (decision: unknown) => decision,
}));

mock.module("../home-feed-side-effect.js", () => ({
  writeHomeFeedItemForSignal: (...args: unknown[]) =>
    homeFeedWriteMock(...args),
}));

mock.module("../runtime-dispatch.js", () => ({
  dispatchDecision: (...args: unknown[]) => dispatchDecisionMock(...args),
}));

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import {
  notificationDecisions,
  notificationEvents,
} from "../../persistence/schema/index.js";
import type { EmitSignalParams } from "../emit-signal.js";

await initializeDb();

const { emitNotificationSignal } = await import("../emit-signal.js");

/**
 * A background-origin signal: `isAsyncBackground` is what makes the home feed
 * mirror fire, so the control case proves the gate is what stops it in the
 * suppress case and not some unrelated filter.
 */
function emit(tier?: string) {
  const params: EmitSignalParams<string> = {
    sourceEventName: "activity.completed",
    sourceChannel: "scheduler",
    sourceContextId: "job-1",
    contextPayload: { title: "Background job finished" },
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    ...(tier ? { routingHints: { tier } } : {}),
  };
  return emitNotificationSignal(params);
}

beforeEach(() => {
  getDb().delete(notificationDecisions).run();
  getDb().delete(notificationEvents).run();
  evaluateSignalMock.mockClear();
  dispatchDecisionMock.mockReset();
  dispatchDecisionMock.mockResolvedValue({
    dispatched: true,
    reason: "Dispatched to 1/1 channels",
    deliveryResults: [],
  });
  homeFeedWriteMock.mockReset();
  homeFeedWriteMock.mockResolvedValue(null);
});

describe("emitNotificationSignal attention-tier gate", () => {
  test("a suppress tier reaches no surface", async () => {
    const result = await emit("suppress");

    expect(dispatchDecisionMock).toHaveBeenCalledTimes(0);
    expect(homeFeedWriteMock).toHaveBeenCalledTimes(0);

    expect(result.dispatched).toBe(false);
    expect(result.deduplicated).toBe(false);
    // A suppressed signal is a verdict, not a failure: callers that latch on
    // a completed emit must not treat it as an error.
    expect(result.pipelineFailed).toBe(false);
    expect(result.deliveryResults).toEqual([]);
    expect(result.reason).toContain("suppress");
  });

  test("a suppressed signal keeps its event and decision rows", async () => {
    const result = await emit("suppress");

    // The decision engine ran, so the tier gate cannot be short-circuiting
    // the audit trail it is supposed to preserve.
    expect(evaluateSignalMock).toHaveBeenCalledTimes(1);

    const events = getDb().select().from(notificationEvents).all();
    expect(events.map((e) => e.id)).toEqual([result.signalId]);

    const decisions = getDb().select().from(notificationDecisions).all();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.notificationEventId).toBe(result.signalId);
  });

  test("a hint tier still dispatches and still mirrors to the home feed", async () => {
    const result = await emit("hint");

    expect(dispatchDecisionMock).toHaveBeenCalledTimes(1);
    expect(homeFeedWriteMock).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(true);
    expect(result.pipelineFailed).toBe(false);
  });

  test("a signal with no tier is unaffected", async () => {
    const result = await emit();

    expect(dispatchDecisionMock).toHaveBeenCalledTimes(1);
    expect(homeFeedWriteMock).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(true);
  });

  test("a routing hint that is not a tier does not suppress", async () => {
    // An unrecognized hint must not be read as "do not surface": silently
    // dropping notifications is the worse failure mode.
    const result = await emit("urgent");

    expect(dispatchDecisionMock).toHaveBeenCalledTimes(1);
    expect(homeFeedWriteMock).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(true);
  });
});
