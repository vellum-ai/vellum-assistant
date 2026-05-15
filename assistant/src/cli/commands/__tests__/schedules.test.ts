import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let ipcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: { schedules: [] } };
let logLines: string[] = [];
let errorLines: string[] = [];
let exitFromIpcResultCalls: unknown[] = [];

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return mockIpcResult;
  },
  exitFromIpcResult: (result: unknown) => {
    exitFromIpcResultCalls.push(result);
    process.exitCode = 10;
    throw new Error("exitFromIpcResult called");
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: (message: string) => logLines.push(message),
    warn: () => {},
    error: (message: string) => errorLines.push(message),
    debug: () => {},
  }),
}));

const { registerSchedulesCommand } = await import("../schedules.js");

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerSchedulesCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
  };
}

beforeEach(() => {
  ipcCalls = [];
  logLines = [];
  errorLines = [];
  exitFromIpcResultCalls = [];
  mockIpcResult = { ok: true, result: { schedules: [] } };
  process.exitCode = 0;
});

describe("schedules command", () => {
  test("registers the current schedules subcommands", () => {
    const program = new Command();
    registerSchedulesCommand(program);

    const schedules = program.commands.find(
      (command) => command.name() === "schedules",
    );
    expect(schedules).toBeDefined();
    expect(schedules!.commands.map((command) => command.name())).toEqual([
      "list",
      "runs",
      "cancel",
      "execute",
    ]);
  });
});

describe("schedules list", () => {
  test("calls listSchedules with empty query params", async () => {
    const { exitCode } = await runCommand(["schedules", "list"]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      { method: "listSchedules", params: { queryParams: {} } },
    ]);
  });

  test("passes include_all when --all is set", async () => {
    await runCommand(["schedules", "list", "--all"]);

    expect(ipcCalls).toEqual([
      {
        method: "listSchedules",
        params: { queryParams: { include_all: "true" } },
      },
    ]);
  });

  test("emits compact JSON when --json is set", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        schedules: [
          {
            id: "schedule-1",
            name: "Heartbeat",
            enabled: true,
            syntax: "cron",
            expression: "*/30 * * * *",
            cronExpression: "*/30 * * * *",
            timezone: "UTC",
            message: "run heartbeat",
            script: null,
            nextRunAt: 1_778_800_000_000,
            lastRunAt: null,
            lastStatus: "ok",
            retryCount: 0,
            maxRetries: 3,
            retryBackoffMs: 60_000,
            description: "Every 30 minutes",
            mode: "execute",
            status: "active",
            routingIntent: "all_channels",
            reuseConversation: false,
            wakeConversationId: null,
            isOneShot: false,
          },
        ],
      },
    };

    const { stdout, exitCode } = await runCommand([
      "schedules",
      "list",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      schedules: [
        expect.objectContaining({
          id: "schedule-1",
          name: "Heartbeat",
        }),
      ],
    });
  });

  test("renders a table for human output", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        schedules: [
          {
            id: "schedule-1",
            name: "Heartbeat",
            enabled: true,
            syntax: "cron",
            expression: "*/30 * * * *",
            cronExpression: "*/30 * * * *",
            timezone: "UTC",
            message: "run heartbeat",
            script: null,
            nextRunAt: 1_778_800_000_000,
            lastRunAt: null,
            lastStatus: "ok",
            retryCount: 0,
            maxRetries: 3,
            retryBackoffMs: 60_000,
            description: "Every 30 minutes",
            mode: "execute",
            status: "active",
            routingIntent: "all_channels",
            reuseConversation: false,
            wakeConversationId: null,
            isOneShot: false,
          },
        ],
      },
    };

    const { exitCode } = await runCommand(["schedules", "list"]);

    expect(exitCode).toBe(0);
    expect(logLines.join("\n")).toContain("ID");
    expect(logLines.join("\n")).toContain("Heartbeat");
    expect(logLines.join("\n")).toContain("Every 30 minutes (UTC)");
  });

  test("sets exit code on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "daemon unavailable" };

    const { exitCode } = await runCommand(["schedules", "list"]);

    expect(exitCode).not.toBe(0);
    expect(errorLines).toEqual(["daemon unavailable"]);
  });

  test("emits JSON error on IPC failure with --json", async () => {
    mockIpcResult = { ok: false, error: "daemon unavailable" };

    const { exitCode, stdout } = await runCommand([
      "schedules",
      "list",
      "--json",
    ]);

    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: "daemon unavailable",
    });
  });
});

describe("schedules runs", () => {
  test("calls listScheduleRuns with the schedule ID path param", async () => {
    mockIpcResult = { ok: true, result: { runs: [] } };

    const { exitCode } = await runCommand(["schedules", "runs", "schedule-1"]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "listScheduleRuns",
        params: { pathParams: { id: "schedule-1" }, queryParams: {} },
      },
    ]);
  });

  test("passes limit query param when --limit is set", async () => {
    mockIpcResult = { ok: true, result: { runs: [] } };

    await runCommand(["schedules", "runs", "schedule-1", "--limit", "25"]);

    expect(ipcCalls).toEqual([
      {
        method: "listScheduleRuns",
        params: {
          pathParams: { id: "schedule-1" },
          queryParams: { limit: "25" },
        },
      },
    ]);
  });

  test("emits JSON result when --json is set", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        runs: [
          {
            id: "run-1",
            jobId: "schedule-1",
            status: "ok",
            startedAt: 1_778_799_000_000,
            finishedAt: 1_778_799_002_500,
            durationMs: 2_500,
            output: "done",
            error: null,
            conversationId: "conversation-1",
            createdAt: 1_778_799_000_000,
          },
        ],
      },
    };

    const { stdout, exitCode } = await runCommand([
      "schedules",
      "runs",
      "schedule-1",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      runs: [expect.objectContaining({ id: "run-1", jobId: "schedule-1" })],
    });
  });

  test("renders a table for human output", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        runs: [
          {
            id: "run-1",
            jobId: "schedule-1",
            status: "ok",
            startedAt: 1_778_799_000_000,
            finishedAt: 1_778_799_002_500,
            durationMs: 2_500,
            output: "done",
            error: null,
            conversationId: "conversation-1",
            createdAt: 1_778_799_000_000,
          },
        ],
      },
    };

    const { exitCode } = await runCommand(["schedules", "runs", "schedule-1"]);

    expect(exitCode).toBe(0);
    expect(logLines.join("\n")).toContain("STATUS");
    expect(logLines.join("\n")).toContain("run-1");
    expect(logLines.join("\n")).toContain("2500ms");
    expect(logLines.join("\n")).toContain("conversation-1");
  });

  test("prints an empty message when no runs are found", async () => {
    mockIpcResult = { ok: true, result: { runs: [] } };

    const { exitCode } = await runCommand(["schedules", "runs", "schedule-1"]);

    expect(exitCode).toBe(0);
    expect(logLines).toEqual(["No runs found for schedule schedule-1."]);
  });

  test("routes IPC failure through exitFromIpcResult", async () => {
    mockIpcResult = { ok: false, error: "Schedule not found" };

    const { exitCode } = await runCommand([
      "schedules",
      "runs",
      "missing-schedule",
    ]);

    expect(exitCode).toBe(10);
    expect(exitFromIpcResultCalls).toEqual([mockIpcResult]);
    expect(errorLines).toEqual([]);
  });
});

describe("schedules cancel", () => {
  test("calls cancelSchedule with the schedule ID path param", async () => {
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "cancel",
      "schedule-1",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "cancelSchedule",
        params: { pathParams: { id: "schedule-1" } },
      },
    ]);
    expect(logLines).toEqual(["Cancelled schedule: schedule-1"]);
  });

  test("emits JSON result when --json is set", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        schedules: [
          {
            id: "remaining-schedule",
            name: "Heartbeat",
            enabled: true,
            syntax: "cron",
            expression: "*/30 * * * *",
            cronExpression: "*/30 * * * *",
            timezone: "UTC",
            message: "run heartbeat",
            script: null,
            nextRunAt: 1_778_800_000_000,
            lastRunAt: null,
            lastStatus: "ok",
            retryCount: 0,
            maxRetries: 3,
            retryBackoffMs: 60_000,
            description: "Every 30 minutes",
            mode: "execute",
            status: "active",
            routingIntent: "all_channels",
            reuseConversation: false,
            wakeConversationId: null,
            isOneShot: false,
          },
        ],
      },
    };

    const { stdout, exitCode } = await runCommand([
      "schedules",
      "cancel",
      "schedule-1",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      schedules: [expect.objectContaining({ id: "remaining-schedule" })],
    });
    expect(logLines).toEqual([]);
  });

  test("routes IPC failure through exitFromIpcResult", async () => {
    mockIpcResult = {
      ok: false,
      error: "Schedule not found or not cancellable",
    };

    const { exitCode } = await runCommand([
      "schedules",
      "cancel",
      "missing-schedule",
    ]);

    expect(exitCode).toBe(10);
    expect(exitFromIpcResultCalls).toEqual([mockIpcResult]);
    expect(errorLines).toEqual([]);
  });
});

describe("schedules execute", () => {
  test("calls runScheduleNow with the schedule ID path param", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        schedules: [
          {
            id: "schedule-1",
            name: "Heartbeat",
            enabled: true,
            syntax: "cron",
            expression: "*/30 * * * *",
            cronExpression: "*/30 * * * *",
            timezone: "UTC",
            message: "run heartbeat",
            script: null,
            nextRunAt: 1_778_800_000_000,
            lastRunAt: 1_778_799_000_000,
            lastStatus: "ok",
            retryCount: 0,
            maxRetries: 3,
            retryBackoffMs: 60_000,
            description: "Every 30 minutes",
            mode: "execute",
            status: "active",
            routingIntent: "all_channels",
            reuseConversation: false,
            wakeConversationId: null,
            isOneShot: false,
          },
        ],
      },
    };

    const { exitCode } = await runCommand([
      "schedules",
      "execute",
      "schedule-1",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "runScheduleNow",
        params: { pathParams: { id: "schedule-1" } },
      },
    ]);
    expect(logLines.join("\n")).toContain(
      "Executed schedule: Heartbeat (schedule-1)",
    );
    expect(logLines.join("\n")).toContain("Last status: ok");
  });

  test("emits JSON result when --json is set", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        schedules: [
          {
            id: "schedule-1",
            name: "Heartbeat",
            enabled: true,
            syntax: "cron",
            expression: "*/30 * * * *",
            cronExpression: "*/30 * * * *",
            timezone: "UTC",
            message: "run heartbeat",
            script: null,
            nextRunAt: 1_778_800_000_000,
            lastRunAt: 1_778_799_000_000,
            lastStatus: "ok",
            retryCount: 0,
            maxRetries: 3,
            retryBackoffMs: 60_000,
            description: "Every 30 minutes",
            mode: "execute",
            status: "active",
            routingIntent: "all_channels",
            reuseConversation: false,
            wakeConversationId: null,
            isOneShot: false,
          },
        ],
      },
    };

    const { stdout, exitCode } = await runCommand([
      "schedules",
      "execute",
      "schedule-1",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      schedules: [expect.objectContaining({ id: "schedule-1" })],
    });
  });

  test("routes IPC failure through exitFromIpcResult", async () => {
    mockIpcResult = { ok: false, error: "Schedule not found" };

    const { exitCode } = await runCommand([
      "schedules",
      "execute",
      "missing-schedule",
    ]);

    expect(exitCode).toBe(10);
    expect(exitFromIpcResultCalls).toEqual([mockIpcResult]);
    expect(errorLines).toEqual([]);
  });

  test("routes JSON IPC failure through exitFromIpcResult", async () => {
    mockIpcResult = { ok: false, error: "Schedule not found" };

    const { stdout, exitCode } = await runCommand([
      "schedules",
      "execute",
      "missing-schedule",
      "--json",
    ]);

    expect(exitCode).toBe(10);
    expect(stdout).toBe("");
    expect(exitFromIpcResultCalls).toEqual([mockIpcResult]);
  });
});
