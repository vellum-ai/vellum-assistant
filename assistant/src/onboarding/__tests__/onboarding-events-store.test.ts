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
import { onboardingEvents } from "../../persistence/schema/index.js";
import {
  queryUnreportedOnboardingEvents,
  recordActivationEvent,
  recordOnboardingEvent,
} from "../onboarding-events-store.js";

await initializeDb();

function resetTable(): void {
  getTelemetryDb()!.delete(onboardingEvents).run();
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

  test("persists an activation funnel event that round-trips through the query", () => {
    const event = recordActivationEvent({
      stepName: "activation_moment_1_complete",
      sessionId: "conv-1",
    });
    expect(event).not.toBeNull();

    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.stepName).toBe("activation_moment_1_complete");
    expect(row.stepIndex).toBe(1);
    expect(row.funnelVersion).toBe("activation_v1_2026_06");
    expect(row.screen).toBe("activation_moment_1_complete");
    expect(row.abVariant).toBe("variant-a");
    expect(row.sessionId).toBe("conv-1");
    expect(row.completedAt).toBe(new Date(row.createdAt).toISOString());
  });

  test("writes the row into the dedicated telemetry database", () => {
    const event = recordActivationEvent({
      stepName: "activation_moment_1_complete",
      sessionId: "conv-telemetry",
    });
    expect(event).not.toBeNull();

    const raw = getTelemetrySqlite()!
      .query(`SELECT id, session_id FROM onboarding_events`)
      .all() as Array<{ id: string; session_id: string }>;
    expect(raw).toEqual([{ id: event!.id, session_id: "conv-telemetry" }]);
  });

  test("honors an explicit abVariant override", () => {
    recordActivationEvent({
      stepName: "activation_moment_2_complete",
      sessionId: "conv-2",
      abVariant: "variant-b",
    });

    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.abVariant).toBe("variant-b");
    expect(rows[0]!.stepIndex).toBe(2);
  });

  test("returns null and writes no row when share_analytics is disabled", () => {
    shareAnalytics = false;
    const event = recordActivationEvent({
      stepName: "activation_moment_1_complete",
      sessionId: "conv-3",
    });
    expect(event).toBeNull();

    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(0);
  });

  test("returns null when the telemetry database is unavailable", () => {
    withTelemetryDbUnavailable(() => {
      const event = recordActivationEvent({
        stepName: "activation_moment_1_complete",
        sessionId: "conv-4",
      });
      expect(event).toBeNull();
      expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
    });

    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });
});

describe("onboarding-events-store: recordOnboardingEvent", () => {
  beforeEach(() => {
    shareAnalytics = true;
    resetTable();
  });

  test("persists a pre-chat onboarding event into the telemetry database", () => {
    const event = recordOnboardingEvent({
      screen: "tools",
      tools: ["gmail", "calendar"],
      tone: "warm",
      googleConnected: true,
    });
    expect(event).not.toBeNull();

    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.screen).toBe("tools");
    expect(rows[0]!.toolsJson).toBe(JSON.stringify(["gmail", "calendar"]));
    expect(rows[0]!.tone).toBe("warm");
    expect(rows[0]!.googleConnected).toBe(true);

    const raw = getTelemetrySqlite()!
      .query(`SELECT id FROM onboarding_events`)
      .all() as Array<{ id: string }>;
    expect(raw).toEqual([{ id: event!.id }]);
  });

  test("returns null and writes no row when share_analytics is disabled", () => {
    shareAnalytics = false;
    expect(recordOnboardingEvent({ screen: "tools" })).toBeNull();
    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("returns null when the telemetry database is unavailable", () => {
    withTelemetryDbUnavailable(() => {
      expect(recordOnboardingEvent({ screen: "tools" })).toBeNull();
    });

    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });
});
