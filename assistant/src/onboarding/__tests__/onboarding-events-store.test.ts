import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mutable consent gate, flipped per-test.
let shareAnalytics = true;
mock.module("../../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { onboardingEvents } from "../../persistence/schema/index.js";
import {
  queryUnreportedOnboardingEvents,
  recordActivationEvent,
} from "../onboarding-events-store.js";

await initializeDb();

function resetTable(): void {
  getDb().delete(onboardingEvents).run();
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
});
