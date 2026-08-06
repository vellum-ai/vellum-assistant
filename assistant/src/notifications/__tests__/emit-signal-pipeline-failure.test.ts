/**
 * Regression tests for what a failed emit leaves behind in the events store.
 *
 * `createEvent` claims the producer's dedupe key as its first pipeline step.
 * A failure after that point releases the claim, so the retry is not
 * short-circuited as "deduplicated at event store level" by an emit that
 * never reached a verdict. A completed emit keeps its claim so real
 * duplicates still collapse.
 *
 * A failure that already reached a channel keeps its claim too: the retry
 * would broadcast under a fresh decision id, and delivery dedupe is keyed to
 * the decision, so every channel that already went out would go out twice.
 *
 * The events store, its DB, and the deterministic checks are the real ones;
 * only the decision engine, the dispatch step, and the adapter graph around
 * them are stubbed.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const dispatchDecisionMock = mock();

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

const DEDUPE_KEY = "schedule-definition-error:plugin:news/digest:2026-01-01";

mock.module("../decision-engine.js", () => ({
  evaluateSignal: async () => ({
    shouldNotify: true,
    selectedChannels: ["vellum"],
    reasoningSummary: "deliver",
    renderedCopy: {
      vellum: { title: "Plugin schedule error", body: "digest failed to load" },
    },
    dedupeKey: DEDUPE_KEY,
    confidence: 0.9,
    fallbackUsed: false,
  }),
  enforceRoutingIntent: (decision: unknown) => decision,
}));

mock.module("../decisions-store.js", () => ({
  updateDecision: () => {},
}));

mock.module("../home-feed-side-effect.js", () => ({
  writeHomeFeedItemForSignal: async () => {},
}));

mock.module("../runtime-dispatch.js", () => ({
  dispatchDecision: (...args: unknown[]) => dispatchDecisionMock(...args),
}));

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { notificationEvents } from "../../persistence/schema/index.js";
import type { EmitSignalParams } from "../emit-signal.js";
import type { NotificationDeliveryResult } from "../types.js";

await initializeDb();

const { emitNotificationSignal } = await import("../emit-signal.js");

function emit() {
  const params: EmitSignalParams<string> = {
    sourceEventName: "schedule.definition_error",
    sourceChannel: "scheduler",
    sourceContextId: "plugin:news/digest",
    dedupeKey: DEDUPE_KEY,
    contextPayload: { pluginName: "news", scheduleName: "digest" },
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
  };
  return emitNotificationSignal(params);
}

/**
 * Stub one dispatch as a broadcast that settles the given channels and then
 * throws on a later channel's prep. What already happened leaves the
 * broadcast through the results sink; the return value dies with the throw.
 */
function throwAfterChannels(...settled: NotificationDeliveryResult[]): void {
  dispatchDecisionMock.mockImplementationOnce(
    (
      _signal: unknown,
      _decision: unknown,
      _broadcaster: unknown,
      options: { resultsSink?: NotificationDeliveryResult[] },
    ) => {
      options.resultsSink?.push(...settled);
      throw new Error("conversation pairing failed for a later channel");
    },
  );
}

beforeEach(() => {
  getDb().delete(notificationEvents).run();
  dispatchDecisionMock.mockReset();
  dispatchDecisionMock.mockResolvedValue({
    dispatched: true,
    reason: "Dispatched to 1/1 channels",
    deliveryResults: [],
  });
});

describe("emitNotificationSignal dedupe claim on failure", () => {
  test("a retry after a mid-pipeline failure dispatches", async () => {
    dispatchDecisionMock.mockRejectedValueOnce(new Error("transient outage"));

    const failed = await emit();
    expect(failed.pipelineFailed).toBe(true);
    expect(failed.dispatched).toBe(false);

    const retried = await emit();
    expect(retried.pipelineFailed).toBe(false);
    expect(retried.deduplicated).toBe(false);
    expect(retried.dispatched).toBe(true);

    // The failed attempt keeps its row for the audit trail; only its claim on
    // the dedupe key is released.
    const rows = getDb().select().from(notificationEvents).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === failed.signalId)?.dedupeKey).toBeNull();
    expect(rows.find((r) => r.id === retried.signalId)?.dedupeKey).toBe(
      DEDUPE_KEY,
    );
  });

  // "sent" is a completed channel delivery; "pending" is the platform push
  // that passed its outcome deadline and is still in flight. Both are
  // side effects a retry would repeat.
  for (const status of ["sent", "pending"] as const) {
    test(`a failure after a ${status} channel keeps its dedupe key`, async () => {
      throwAfterChannels({
        channel: "vellum",
        destination: "vellum",
        status,
      });

      const partial = await emit();
      expect(partial.pipelineFailed).toBe(true);

      const retried = await emit();
      expect(retried.deduplicated).toBe(true);
      expect(retried.dispatched).toBe(false);
      expect(dispatchDecisionMock).toHaveBeenCalledTimes(1);

      const rows = getDb().select().from(notificationEvents).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dedupeKey).toBe(DEDUPE_KEY);
    });
  }

  test("a failure after only skipped and failed channels releases its key", async () => {
    throwAfterChannels(
      { channel: "slack", destination: "slack", status: "skipped" },
      { channel: "telegram", destination: "telegram", status: "failed" },
    );

    const failed = await emit();
    expect(failed.pipelineFailed).toBe(true);

    const retried = await emit();
    expect(retried.deduplicated).toBe(false);
    expect(retried.dispatched).toBe(true);
  });

  test("a completed emit keeps its dedupe key, so a repeat is deduplicated", async () => {
    const first = await emit();
    expect(first.dispatched).toBe(true);

    const second = await emit();
    expect(second.deduplicated).toBe(true);
    expect(second.dispatched).toBe(false);
    expect(second.pipelineFailed).toBe(false);
    expect(dispatchDecisionMock).toHaveBeenCalledTimes(1);
  });
});
