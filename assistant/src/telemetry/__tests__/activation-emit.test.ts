import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Usage-data collection is enabled for these tests.
mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ collectUsageData: true }),
}));

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { queryUnreportedOnboardingEvents } from "../../memory/onboarding-events-store.js";
import { onboardingEvents } from "../../memory/schema.js";
import { emitActivationMoment } from "../activation-emit.js";

initializeDb();

function resetTable(): void {
  getDb().delete(onboardingEvents).run();
}

describe("activation-emit: emitActivationMoment", () => {
  beforeEach(() => {
    resetTable();
  });

  test("records a valid activation moment and writes a row", () => {
    const result = emitActivationMoment({
      stepName: "activation_moment_2_complete",
      conversationId: "conv-1",
    });
    expect(result).toEqual({ ok: true });

    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stepName).toBe("activation_moment_2_complete");
    expect(rows[0]!.sessionId).toBe("conv-1");
  });

  test("rejects the daemon-owned msg_5 step and writes no row", () => {
    const result = emitActivationMoment({
      stepName: "activation_msg_5_sent",
      conversationId: "conv-2",
    });
    expect(result).toEqual({ ok: false, reason: "daemon_owned" });

    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("rejects an unknown step name and writes no row", () => {
    const result = emitActivationMoment({
      stepName: "bogus",
      conversationId: "conv-3",
    });
    expect(result).toEqual({ ok: false, reason: "unknown_step" });

    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });
});
