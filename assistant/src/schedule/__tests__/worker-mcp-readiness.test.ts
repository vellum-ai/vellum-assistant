/**
 * Scheduler gate for tool-backed schedules while the MCP surface is not ready.
 *
 * A due execute schedule must not record success while worker MCP
 * initialization is still incomplete. Once ready, the expected MCP tool
 * has to be present in the registry the turn would use.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { RiskLevel } from "../../tools/tool-types.js";
import { createSchedule } from "../schedule-store.js";
import {
  markScheduleToolSurfaceStarting,
  resetScheduleToolSurfaceReadinessForTests,
} from "../tool-surface-readiness.js";

const processedPrompts: string[] = [];
mock.module("../../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: { prompt: string }) => {
    const { getMcpToolDefinitions } = await import("../../tools/registry.js");
    capturedMcpTools = getMcpToolDefinitions().map((tool) => tool.name);
    processedPrompts.push(opts.prompt);
    return { conversationId: "conv-xyz", ok: true };
  },
}));

mock.module("../../daemon/process-message.js", () => ({
  processMessage: async () => ({ messageId: "msg-xyz" }),
  processMessageInBackground: async () => {},
}));

mock.module("../../background-wake/publisher.js", () => ({
  refreshBackgroundWakeIntent: () => {},
}));

mock.module("../../daemon/disk-pressure-background-gate.js", () => ({
  checkDiskPressureBackgroundGate: () => ({
    action: "allow",
    status: {
      enabled: false,
      state: "disabled",
      locked: false,
      acknowledged: false,
      overrideActive: false,
      effectivelyLocked: false,
      lockId: null,
      usagePercent: null,
      thresholdPercent: 95,
      path: null,
      lastCheckedAt: null,
      blockedCapabilities: [],
      error: null,
    },
  }),
  diskPressureBackgroundSkipLogFields: () => ({}),
  shouldLogDiskPressureBackgroundSkip: () => false,
}));

const mockEmitNotificationSignal = mock(() => Promise.resolve());
mock.module("../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: mockEmitNotificationSignal,
}));

const { runDueSchedulesOnce } = await import("../scheduler.js");
const { __resetRegistryForTesting, getTool, registerMcpTools } =
  await import("../../tools/registry.js");

await initializeDb();

let capturedMcpTools: string[] = [];

function rawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

afterEach(() => {
  resetScheduleToolSurfaceReadinessForTests();
  processedPrompts.length = 0;
  capturedMcpTools = [];
  mockEmitNotificationSignal.mockClear();
  __resetRegistryForTesting();
  const db = getDb();
  db.run("DELETE FROM cron_runs");
  db.run("DELETE FROM cron_jobs");
});

describe("automatic schedule MCP readiness", () => {
  test("defers a due execute schedule while MCP is still starting", async () => {
    markScheduleToolSurfaceStarting(8);
    const job = await createSchedule({
      name: "Friday tagging",
      cronExpression: "* * * * *",
      message: "Tag new Reader documents",
      mode: "execute",
    });
    rawDb().run("UPDATE cron_jobs SET next_run_at = ?", [Date.now() - 1000]);

    const result = await runDueSchedulesOnce();

    expect(result.claimed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.completed).toBe(0);
    expect(processedPrompts).toEqual([]);
    const runs = rawDb()
      .query("SELECT status FROM cron_runs WHERE job_id = ?")
      .all(job.id) as Array<{ status: string }>;
    expect(runs).toEqual([]);
    const row = rawDb()
      .query("SELECT status, enabled FROM cron_jobs WHERE id = ?")
      .get(job.id) as { status: string; enabled: number };
    expect(row.status).toBe("active");
    expect(row.enabled).toBe(1);
  });

  test("still fires notify and script schedules while MCP is starting", async () => {
    markScheduleToolSurfaceStarting(8);
    await createSchedule({
      name: "Ping",
      cronExpression: "* * * * *",
      message: "ping",
      mode: "notify",
    });
    await createSchedule({
      name: "Script",
      cronExpression: "* * * * *",
      message: "run script",
      mode: "script",
      script: "true",
    });
    rawDb().run("UPDATE cron_jobs SET next_run_at = ?", [Date.now() - 1000]);

    const result = await runDueSchedulesOnce();

    expect(result.completed).toBe(2);
    expect(mockEmitNotificationSignal).toHaveBeenCalledTimes(1);
  });

  test("an automatic execute run sees the registered MCP tool once ready", async () => {
    registerMcpTools("reader", [
      {
        name: "mcp__reader__list_documents",
        description: "List documents",
        defaultRiskLevel: RiskLevel.Low,
        executionTarget: "sandbox",
        input_schema: { type: "object", properties: {}, required: [] },
        category: "",
        async execute() {
          return { content: "ok", isError: false };
        },
      },
    ]);
    resetScheduleToolSurfaceReadinessForTests();

    await createSchedule({
      name: "Saturday digest",
      cronExpression: "* * * * *",
      message: "Build the Reader digest",
      mode: "execute",
    });
    rawDb().run("UPDATE cron_jobs SET next_run_at = ?", [Date.now() - 1000]);

    const result = await runDueSchedulesOnce();

    expect(result.completed).toBe(1);
    expect(processedPrompts).toEqual(["Build the Reader digest"]);
    expect(capturedMcpTools).toContain("mcp__reader__list_documents");
    expect(getTool("mcp__reader__list_documents")).toBeDefined();
  });
});
