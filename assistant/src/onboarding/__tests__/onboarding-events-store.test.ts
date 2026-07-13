import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// Mutable consent gate, flipped per-test.
let shareAnalytics = true;
mock.module("../../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import * as dbConnection from "../../persistence/db-connection.js";
import {
  getTelemetryDb,
  getTelemetrySqlite,
} from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { telemetryEvents } from "../../persistence/schema/index.js";
import { ACTIVATION_FUNNEL_VERSION } from "../../telemetry/activation-funnel.js";
import { queryTelemetryOutboxBatch } from "../../telemetry/telemetry-events-outbox.js";
import type { OnboardingTelemetryEvent } from "../../telemetry/types.js";
import { APP_VERSION } from "../../version.js";
import {
  recordActivationEvent,
  recordOnboardingEvent,
} from "../onboarding-events-store.js";

await initializeDb();

function resetTable(): void {
  getTelemetryDb()!.delete(telemetryEvents).run();
}

/** Pending onboarding outbox payloads, parsed, in `(created_at, id)` order. */
function pendingOnboardingPayloads(): OnboardingTelemetryEvent[] {
  return queryTelemetryOutboxBatch("onboarding", 10).map(
    (row) => JSON.parse(row.payload) as OnboardingTelemetryEvent,
  );
}

/** Run `fn` with the dedicated telemetry connection reported as unavailable. */
function withTelemetryDbUnavailable(fn: () => void): void {
  const spy = spyOn(dbConnection, "getTelemetryDb").mockReturnValue(null);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}

describe("onboarding-events-store: recordActivationEvent", () => {
  beforeEach(() => {
    shareAnalytics = true;
    resetTable();
  });

  test("stores the full wire payload with the deterministic activation daemon_event_id", () => {
    const event = recordActivationEvent({
      stepName: "activation_moment_1_complete",
      sessionId: "conv-1",
    });
    expect(event).not.toBeNull();

    const payloads = pendingOnboardingPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      type: "onboarding",
      daemon_event_id: `${ACTIVATION_FUNNEL_VERSION}:conv-1:activation_moment_1_complete`,
      recorded_at: event!.createdAt,
      screen: "activation_moment_1_complete",
      ab_variant: "variant-a",
      session_id: "conv-1",
      step_name: "activation_moment_1_complete",
      step_index: 1,
      completed_at: new Date(event!.createdAt).toISOString(),
      funnel_version: ACTIVATION_FUNNEL_VERSION,
      assistant_version: APP_VERSION,
    });
    expect(event!.completedAt).toBe(new Date(event!.createdAt).toISOString());
  });

  test("outbox row id stays a UUID distinct from the payload daemon_event_id", () => {
    const event = recordActivationEvent({
      stepName: "activation_moment_1_complete",
      sessionId: "conv-telemetry",
    });
    expect(event).not.toBeNull();

    const raw = getTelemetrySqlite()!
      .query(`SELECT id, name FROM telemetry_events`)
      .all() as Array<{ id: string; name: string }>;
    expect(raw).toEqual([{ id: event!.id, name: "onboarding" }]);
    const payload = pendingOnboardingPayloads()[0]!;
    expect(payload.daemon_event_id).not.toBe(event!.id);
  });

  test("honors an explicit abVariant override", () => {
    recordActivationEvent({
      stepName: "activation_moment_2_complete",
      sessionId: "conv-2",
      abVariant: "variant-b",
    });

    const payloads = pendingOnboardingPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.ab_variant).toBe("variant-b");
    expect(payloads[0]!.step_index).toBe(2);
  });

  test("returns null and writes no row when share_analytics is disabled", () => {
    shareAnalytics = false;
    const event = recordActivationEvent({
      stepName: "activation_moment_1_complete",
      sessionId: "conv-3",
    });
    expect(event).toBeNull();

    expect(pendingOnboardingPayloads()).toHaveLength(0);
  });

  test("returns null when the telemetry database is unavailable", () => {
    withTelemetryDbUnavailable(() => {
      const event = recordActivationEvent({
        stepName: "activation_moment_1_complete",
        sessionId: "conv-4",
      });
      expect(event).toBeNull();
    });

    expect(pendingOnboardingPayloads()).toHaveLength(0);
  });
});

describe("onboarding-events-store: recordOnboardingEvent", () => {
  beforeEach(() => {
    shareAnalytics = true;
    resetTable();
  });

  test("stores a pre-chat wire payload with daemon_event_id = row id and no funnel fields", () => {
    const event = recordOnboardingEvent({
      screen: "tools",
      tools: ["gmail", "calendar"],
      tone: "warm",
      googleConnected: true,
      priorAssistants: ["siri"],
    });
    expect(event).not.toBeNull();

    const payloads = pendingOnboardingPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      type: "onboarding",
      daemon_event_id: event!.id,
      recorded_at: event!.createdAt,
      screen: "tools",
      tools: ["gmail", "calendar"],
      tone: "warm",
      google_connected: true,
      assistant_version: APP_VERSION,
    });

    const raw = getTelemetrySqlite()!
      .query(`SELECT id, name, conversation_id FROM telemetry_events`)
      .all() as Array<{
      id: string;
      name: string;
      conversation_id: string | null;
    }>;
    expect(raw).toEqual([
      { id: event!.id, name: "onboarding", conversation_id: null },
    ]);
  });

  test("returns null and writes no row when share_analytics is disabled", () => {
    shareAnalytics = false;
    expect(recordOnboardingEvent({ screen: "tools" })).toBeNull();
    expect(pendingOnboardingPayloads()).toHaveLength(0);
  });

  test("returns null when the telemetry database is unavailable", () => {
    withTelemetryDbUnavailable(() => {
      expect(recordOnboardingEvent({ screen: "tools" })).toBeNull();
    });

    expect(pendingOnboardingPayloads()).toHaveLength(0);
  });
});
