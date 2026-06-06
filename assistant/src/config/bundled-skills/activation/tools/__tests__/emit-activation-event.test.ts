import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Usage-data collection is enabled for these tests.
mock.module("../../../../../config/loader.js", () => ({
  getConfig: () => ({ collectUsageData: true }),
}));

import { markActivationSession } from "../../../../../memory/activation-session-store.js";
import { getDb } from "../../../../../memory/db-connection.js";
import { initializeDb } from "../../../../../memory/db-init.js";
import { queryUnreportedOnboardingEvents } from "../../../../../memory/onboarding-events-store.js";
import {
  activationSessions,
  onboardingEvents,
} from "../../../../../memory/schema.js";
import type { ToolContext } from "../../../../../tools/types.js";
import { run } from "../emit-activation-event.js";

initializeDb();

function resetTables(): void {
  getDb().delete(onboardingEvents).run();
  getDb().delete(activationSessions).run();
}

function ctx(conversationId: string): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId,
    trustClass: "guardian",
  };
}

describe("emit_activation_event tool", () => {
  beforeEach(resetTables);

  test("records one row for a valid step in a marked rail session", async () => {
    markActivationSession("conv-1");
    const result = await run(
      { step_name: "activation_moment_2_complete" },
      ctx("conv-1"),
    );
    expect(result.isError).toBe(false);

    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stepName).toBe("activation_moment_2_complete");
    expect(rows[0]!.sessionId).toBe("conv-1");
  });

  test("rejects the daemon-owned msg_5 step: non-error result, no row", async () => {
    markActivationSession("conv-2");
    const result = await run(
      { step_name: "activation_msg_5_sent" },
      ctx("conv-2"),
    );
    expect(result.isError).toBe(false);
    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("malformed/unknown input: non-error result, no row", async () => {
    markActivationSession("conv-3");

    const unknown = await run({ step_name: "bogus" }, ctx("conv-3"));
    expect(unknown.isError).toBe(false);

    const missing = await run({}, ctx("conv-3"));
    expect(missing.isError).toBe(false);

    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });
});
