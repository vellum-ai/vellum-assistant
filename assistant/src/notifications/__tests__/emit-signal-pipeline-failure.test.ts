/**
 * Regression tests for what a failed emit leaves behind in the events store.
 *
 * `createEvent` claims the producer's dedupe key as its first pipeline step,
 * so a failure after that point used to leave the key claimed by an emit that
 * never reached a verdict: every retry short-circuited as "deduplicated at
 * event store level" and nothing was ever delivered. The failure path releases
 * the claim instead, while a completed emit keeps it so real duplicates still
 * collapse.
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
