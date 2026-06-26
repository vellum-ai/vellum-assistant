/**
 * Asserts the `wake_conversation` route derives trust + attribution from the
 * per-firing token, never from the request body: a valid live token for a
 * guardian schedule elevates the woken turn to a non-interactive guardian
 * (clientless + guardian trustContext) and attributes its cost to the firing's
 * run id; a restricted/null schedule or an unresolved token runs clientless
 * with no elevation; and the body no longer carries a client-supplied run id.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

interface CapturedWake {
  conversationId: string;
  trustContext?: { sourceChannel: string; trustClass: string };
  cronRunId?: string;
  clientless?: boolean;
}
const wakeCalls: CapturedWake[] = [];
mock.module("../../agent-wake.js", () => ({
  wakeAgentForOpportunity: (opts: CapturedWake) => {
    wakeCalls.push(opts);
    return { invoked: true, producedToolCalls: false };
  },
}));

import { createConversation } from "../../../memory/conversation-crud.js";
import { initializeDb } from "../../../memory/db-init.js";
import { firingTokenRegistry } from "../../../schedule/firing-token-registry.js";
import {
  createSchedule,
  type ScheduleTrustLevel,
} from "../../../schedule/schedule-store.js";
import { ROUTES } from "../wake-conversation-routes.js";

await initializeDb();

const handler = (() => {
  const route = ROUTES.find((r) => r.operationId === "wake_conversation");
  if (!route) throw new Error("wake_conversation route not found");
  return route.handler;
})();

function spawnLive(): Bun.Subprocess {
  return Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
}

function makeScript(trustLevel: ScheduleTrustLevel): {
  jobId: string;
  conversationId: string;
} {
  const job = createSchedule({
    name: `script-${trustLevel}`,
    description: "test",
    cronExpression: "0 * * * *",
    message: "",
    script: "echo hi",
    mode: "script",
    syntax: "cron",
    trustLevel,
  });
  const conv = createConversation({ conversationType: "scheduled" });
  return { jobId: job.id, conversationId: conv.id };
}

describe("wake_conversation route trust elevation", () => {
  test("valid live token + guardian schedule → non-interactive guardian, run id from token", async () => {
    wakeCalls.length = 0;
    const { jobId, conversationId } = makeScript("guardian");
    const runId = "run-guardian-1";
    const token = firingTokenRegistry.mint(runId, jobId);
    const proc = spawnLive();
    try {
      firingTokenRegistry.attachProc(runId, proc);
      const result = await handler({
        body: { conversationId, hint: "poll result", runToken: token },
      });
      expect(result).toEqual({ invoked: true, producedToolCalls: false });
      expect(wakeCalls).toHaveLength(1);
      expect(wakeCalls[0].trustContext).toEqual({
        sourceChannel: "vellum",
        trustClass: "guardian",
      });
      expect(wakeCalls[0].clientless).toBe(true);
      expect(wakeCalls[0].cronRunId).toBe(runId);
    } finally {
      proc.kill();
      firingTokenRegistry.revoke(token);
    }
  });

  test("valid live token + restricted schedule → clientless, no elevation", async () => {
    wakeCalls.length = 0;
    const { jobId, conversationId } = makeScript("restricted");
    const runId = "run-restricted-1";
    const token = firingTokenRegistry.mint(runId, jobId);
    const proc = spawnLive();
    try {
      firingTokenRegistry.attachProc(runId, proc);
      await handler({
        body: { conversationId, hint: "poll result", runToken: token },
      });
      expect(wakeCalls[0].trustContext).toBeUndefined();
      expect(wakeCalls[0].clientless).toBe(true);
      expect(wakeCalls[0].cronRunId).toBe(runId);
    } finally {
      proc.kill();
      firingTokenRegistry.revoke(token);
    }
  });

  test("unresolved token → clientless, no elevation, no run id", async () => {
    wakeCalls.length = 0;
    const { conversationId } = makeScript("guardian");
    await handler({
      body: { conversationId, hint: "poll", runToken: "bogus-token" },
    });
    expect(wakeCalls[0].trustContext).toBeUndefined();
    expect(wakeCalls[0].clientless).toBe(true);
    expect(wakeCalls[0].cronRunId).toBeUndefined();
  });

  test("no token → unchanged interactive wake (no clientless, no elevation)", async () => {
    wakeCalls.length = 0;
    const { conversationId } = makeScript("guardian");
    await handler({ body: { conversationId, hint: "poll" } });
    expect(wakeCalls[0].trustContext).toBeUndefined();
    expect(wakeCalls[0].clientless).toBeUndefined();
    expect(wakeCalls[0].cronRunId).toBeUndefined();
  });

  test("a client-supplied cronRunId in the body is ignored", async () => {
    wakeCalls.length = 0;
    const { conversationId } = makeScript("guardian");
    await handler({
      body: {
        conversationId,
        hint: "poll",
        cronRunId: "attacker-chosen-run",
      },
    });
    expect(wakeCalls[0].cronRunId).toBeUndefined();
  });
});
