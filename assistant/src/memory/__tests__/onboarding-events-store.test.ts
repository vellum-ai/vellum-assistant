import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mutable usage-data gate, flipped per-test.
let collectUsageData = true;
mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ collectUsageData }),
}));

import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import {
  queryUnreportedOnboardingEvents,
  recordActivationEvent,
} from "../onboarding-events-store.js";
import { onboardingEvents } from "../schema.js";

initializeDb();

function resetTable(): void {
  getDb().delete(onboardingEvents).run();
}

describe("onboarding-events-store: recordActivationEvent", () => {
  beforeEach(() => {
    collectUsageData = true;
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

  test("returns null and writes no row when collectUsageData is disabled", () => {
    collectUsageData = false;
    const event = recordActivationEvent({
      stepName: "activation_moment_1_complete",
      sessionId: "conv-3",
    });
    expect(event).toBeNull();

    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(0);
  });
});
