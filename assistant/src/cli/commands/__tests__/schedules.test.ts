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
      "get",
      "runs",
      "create",
      "update",
      "enable",
      "disable",
      "cancel",
      "delete",
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
            description: "Authored heartbeat check",
            cadenceDescription: "Every 30 minutes",
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
          description: "Authored heartbeat check",
          cadenceDescription: "Every 30 minutes",
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
            description: "Authored heartbeat check",
            cadenceDescription: "Every 30 minutes",
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
    expect(logLines.join("\n")).not.toContain("Authored heartbeat check");
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

describe("schedules get", () => {
  const scheduleFixture = {
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
    timeoutMs: null,
    createdFromConversationId: "conv-abc",
    description: "Authored heartbeat check",
    cadenceDescription: "Every 30 minutes",
    mode: "execute",
    status: "active",
    routingIntent: "all_channels",
    reuseConversation: false,
    wakeConversationId: null,
    isOneShot: false,
  };

  test("calls getSchedule with the schedule ID path param", async () => {
    mockIpcResult = { ok: true, result: { schedule: scheduleFixture } };

    const { exitCode } = await runCommand(["schedules", "get", "schedule-1"]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "getSchedule",
        params: { pathParams: { id: "schedule-1" } },
      },
    ]);
  });

  test("inspect alias resolves to the same getSchedule handler", async () => {
    // GIVEN the daemon returns a schedule for the requested ID
    mockIpcResult = { ok: true, result: { schedule: scheduleFixture } };

    // WHEN the user invokes the `inspect` alias instead of `get`
    const { exitCode } = await runCommand([
      "schedules",
      "inspect",
      "schedule-1",
    ]);

    // THEN it calls the same getSchedule IPC method with the ID path param
    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "getSchedule",
        params: { pathParams: { id: "schedule-1" } },
      },
    ]);
    // AND it renders the same human-readable detail view
    expect(logLines.join("\n")).toContain("run heartbeat");
  });

  test("renders a detail view for human output", async () => {
    mockIpcResult = { ok: true, result: { schedule: scheduleFixture } };

    const { exitCode } = await runCommand(["schedules", "get", "schedule-1"]);

    expect(exitCode).toBe(0);
    const output = logLines.join("\n");
    expect(output).toContain("ID:");
    expect(output).toContain("schedule-1");
    expect(output).toContain("Heartbeat");
    expect(output).toContain("Authored heartbeat check");
    expect(output).toContain("Every 30 minutes (UTC)");
    expect(output).toContain("run heartbeat");
    expect(output).toContain("all_channels");
    expect(output).toContain("conv-abc");
  });

  test("emits JSON result when --json is set", async () => {
    mockIpcResult = { ok: true, result: { schedule: scheduleFixture } };

    const { stdout, exitCode } = await runCommand([
      "schedules",
      "get",
      "schedule-1",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      schedule: expect.objectContaining({
        id: "schedule-1",
        name: "Heartbeat",
        description: "Authored heartbeat check",
      }),
    });
    expect(logLines).toEqual([]);
  });

  test("routes IPC failure through exitFromIpcResult", async () => {
    mockIpcResult = { ok: false, error: "Schedule not found" };

    const { exitCode } = await runCommand([
      "schedules",
      "get",
      "missing-schedule",
    ]);

    expect(exitCode).toBe(10);
    expect(exitFromIpcResultCalls).toEqual([mockIpcResult]);
    expect(errorLines).toEqual([]);
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
    expect(logLines.join("\n")).toContain("2.5s");
    expect(logLines.join("\n")).toContain("conversation-1");
  });

  test("formats run durations into human-friendly units", async () => {
    const durations = [
      { ms: 450, expected: "450ms" },
      { ms: 29_854, expected: "29.9s" },
      { ms: 30_000, expected: "30s" },
      { ms: 90_000, expected: "1m 30s" },
      { ms: 300_000, expected: "5m" },
      { ms: 3_600_000, expected: "1h" },
      { ms: 8_100_000, expected: "2h 15m" },
      { ms: 93_600_000, expected: "1d 2h" },
    ];

    mockIpcResult = {
      ok: true,
      result: {
        runs: durations.map((d, i) => ({
          id: `run-${i}`,
          jobId: "schedule-1",
          status: "ok",
          startedAt: 1_778_799_000_000,
          finishedAt: 1_778_799_000_000 + d.ms,
          durationMs: d.ms,
          output: "done",
          error: null,
          conversationId: `conversation-${i}`,
          createdAt: 1_778_799_000_000,
        })),
      },
    };

    const { exitCode } = await runCommand(["schedules", "runs", "schedule-1"]);

    expect(exitCode).toBe(0);
    const output = logLines.join("\n");
    for (const { expected } of durations) {
      expect(output).toContain(expected);
    }
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

describe("schedules create", () => {
  test("calls createSchedule with the required fields", async () => {
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "create",
      "Heartbeat",
      "--expression",
      "*/30 * * * *",
      "--description",
      "Checks service heartbeat",
      "--message",
      "run heartbeat",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "createSchedule",
        params: {
          body: {
            name: "Heartbeat",
            expression: "*/30 * * * *",
            description: "Checks service heartbeat",
            message: "run heartbeat",
            enabled: true,
          },
        },
      },
    ]);
    expect(logLines).toEqual(["Created schedule: Heartbeat"]);
  });

  test("requires a description", async () => {
    const { exitCode } = await runCommand([
      "schedules",
      "create",
      "Heartbeat",
      "--expression",
      "*/30 * * * *",
      "--message",
      "run heartbeat",
    ]);

    expect(exitCode).not.toBe(0);
    expect(ipcCalls).toEqual([]);
  });

  test("rejects an empty description", async () => {
    const { exitCode } = await runCommand([
      "schedules",
      "create",
      "Heartbeat",
      "--expression",
      "*/30 * * * *",
      "--description",
      "   ",
      "--message",
      "run heartbeat",
    ]);

    expect(exitCode).not.toBe(0);
    expect(ipcCalls).toEqual([]);
    expect(errorLines).toEqual(["description is required"]);
  });

  test("passes --timezone through to the request body", async () => {
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "create",
      "Morning",
      "--expression",
      "0 9 * * MON-FRI",
      "--message",
      "morning summary",
      "--description",
      "Summarizes weekday mornings",
      "--timezone",
      "America/New_York",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "createSchedule",
        params: {
          body: {
            name: "Morning",
            expression: "0 9 * * MON-FRI",
            message: "morning summary",
            description: "Summarizes weekday mornings",
            enabled: true,
            timezone: "America/New_York",
          },
        },
      },
    ]);
  });

  test("sends enabled:false when --no-enabled is set", async () => {
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "create",
      "Drafted",
      "--expression",
      "0 0 * * *",
      "--message",
      "placeholder",
      "--description",
      "Draft schedule",
      "--no-enabled",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "createSchedule",
        params: {
          body: {
            name: "Drafted",
            expression: "0 0 * * *",
            message: "placeholder",
            description: "Draft schedule",
            enabled: false,
          },
        },
      },
    ]);
  });

  test("emits JSON when --json is set", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        schedule: {
          id: "new-schedule-id",
          name: "Heartbeat",
          enabled: true,
          syntax: "cron",
          expression: "*/30 * * * *",
          cronExpression: "*/30 * * * *",
          timezone: null,
          message: "run heartbeat",
          script: null,
          nextRunAt: 1_778_800_000_000,
          lastRunAt: null,
          lastStatus: null,
          retryCount: 0,
          maxRetries: 3,
          retryBackoffMs: 60_000,
          description: "Checks service heartbeat",
          cadenceDescription: "Every 30 minutes",
          mode: "execute",
          status: "active",
          routingIntent: "all_channels",
          reuseConversation: false,
          wakeConversationId: null,
          isOneShot: false,
        },
      },
    };

    const { stdout, exitCode } = await runCommand([
      "schedules",
      "create",
      "Heartbeat",
      "--expression",
      "*/30 * * * *",
      "--message",
      "run heartbeat",
      "--description",
      "Checks service heartbeat",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      schedule: expect.objectContaining({
        id: "new-schedule-id",
        description: "Checks service heartbeat",
        cadenceDescription: "Every 30 minutes",
      }),
    });
    expect(logLines).toEqual([]);
  });

  test("routes IPC failure through exitFromIpcResult", async () => {
    mockIpcResult = {
      ok: false,
      error: "expression could not be parsed as cron or rrule",
    };

    const { exitCode } = await runCommand([
      "schedules",
      "create",
      "Bad",
      "--expression",
      "not-a-cron",
      "--message",
      "noop",
      "--description",
      "Invalid test schedule",
    ]);

    expect(exitCode).toBe(10);
    expect(exitFromIpcResultCalls).toEqual([mockIpcResult]);
    expect(errorLines).toEqual([]);
  });

  test("creates a script-mode schedule with --mode script --script", async () => {
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "create",
      "GitHub watcher",
      "--mode",
      "script",
      "--script",
      'cd "$VELLUM_WORKSPACE_DIR/schedules/$__SCHEDULE_ID" && bun poll.ts',
      "--expression",
      "*/15 * * * *",
      "--description",
      "Polls GitHub notifications",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "createSchedule",
        params: {
          body: {
            name: "GitHub watcher",
            expression: "*/15 * * * *",
            description: "Polls GitHub notifications",
            enabled: true,
            mode: "script",
            script:
              'cd "$VELLUM_WORKSPACE_DIR/schedules/$__SCHEDULE_ID" && bun poll.ts',
          },
        },
      },
    ]);
  });

  test("exits 1 when --mode script is missing --script", async () => {
    const { exitCode } = await runCommand([
      "schedules",
      "create",
      "Broken",
      "--mode",
      "script",
      "--expression",
      "*/15 * * * *",
      "--description",
      "no script",
    ]);

    expect(exitCode).toBe(1);
  });
});

describe("schedules update", () => {
  test("calls updateSchedule with only the provided flags", async () => {
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "update",
      "schedule-1",
      "--name",
      "Renamed",
      "--expression",
      "0 9 * * MON-FRI",
      "--timezone",
      "America/New_York",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "updateSchedule",
        params: {
          pathParams: { id: "schedule-1" },
          body: {
            name: "Renamed",
            expression: "0 9 * * MON-FRI",
            timezone: "America/New_York",
          },
        },
      },
    ]);
    expect(logLines).toEqual(["Updated schedule: schedule-1"]);
  });

  test("errors when no update flags are provided", async () => {
    const { exitCode } = await runCommand([
      "schedules",
      "update",
      "schedule-1",
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toEqual([]);
    expect(errorLines.join("\n")).toContain(
      "At least one update flag is required",
    );
  });

  test("parses numeric retry and timeout flags into numbers", async () => {
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "update",
      "schedule-1",
      "--max-retries",
      "5",
      "--retry-backoff-ms",
      "30000",
      "--timeout-ms",
      "5000",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "updateSchedule",
        params: {
          pathParams: { id: "schedule-1" },
          body: { maxRetries: 5, retryBackoffMs: 30_000, timeoutMs: 5000 },
        },
      },
    ]);
  });

  test("rejects a non-integer --max-retries", async () => {
    const { exitCode } = await runCommand([
      "schedules",
      "update",
      "schedule-1",
      "--max-retries",
      "lots",
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toEqual([]);
    expect(errorLines.join("\n")).toContain("--max-retries must be an integer");
  });

  test("sends timeoutMs null with --clear-timeout", async () => {
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "update",
      "schedule-1",
      "--clear-timeout",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "updateSchedule",
        params: {
          pathParams: { id: "schedule-1" },
          body: { timeoutMs: null },
        },
      },
    ]);
  });

  test("rejects --timeout-ms combined with --clear-timeout", async () => {
    const { exitCode } = await runCommand([
      "schedules",
      "update",
      "schedule-1",
      "--timeout-ms",
      "5000",
      "--clear-timeout",
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toEqual([]);
    expect(errorLines.join("\n")).toContain("mutually exclusive");
  });

  test("rejects --mode wake when the schedule has no wake conversation target", async () => {
    mockIpcResult = {
      ok: true,
      result: { schedule: { wakeConversationId: null } },
    };

    const { exitCode } = await runCommand([
      "schedules",
      "update",
      "schedule-1",
      "--mode",
      "wake",
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toEqual([
      { method: "getSchedule", params: { pathParams: { id: "schedule-1" } } },
    ]);
    expect(errorLines.join("\n")).toContain("wake conversation target");
  });

  test("allows --mode wake when the schedule already has a wake target", async () => {
    // The shared mock returns one shape for both IPC calls; satisfy the
    // getSchedule guard and the update response renderer simultaneously.
    mockIpcResult = {
      ok: true,
      result: {
        schedule: { wakeConversationId: "conv-1" },
        schedules: [],
      },
    };

    const { exitCode } = await runCommand([
      "schedules",
      "update",
      "schedule-1",
      "--mode",
      "wake",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toHaveLength(2);
    expect(ipcCalls[0].method).toBe("getSchedule");
    expect(ipcCalls[1]).toEqual({
      method: "updateSchedule",
      params: {
        pathParams: { id: "schedule-1" },
        body: { mode: "wake" },
      },
    });
  });

  test("sends boolean false for negated flags", async () => {
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "update",
      "schedule-1",
      "--no-quiet",
      "--no-reuse-conversation",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "updateSchedule",
        params: {
          pathParams: { id: "schedule-1" },
          body: { quiet: false, reuseConversation: false },
        },
      },
    ]);
  });

  test("emits JSON result when --json is set", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        schedules: [
          {
            id: "schedule-1",
            name: "Renamed",
            enabled: true,
            syntax: "cron",
            expression: "0 9 * * MON-FRI",
            cronExpression: "0 9 * * MON-FRI",
            timezone: "America/New_York",
            message: "run heartbeat",
            script: null,
            nextRunAt: 1_778_800_000_000,
            lastRunAt: null,
            lastStatus: "ok",
            retryCount: 0,
            maxRetries: 3,
            retryBackoffMs: 60_000,
            description: "Authored heartbeat check",
            cadenceDescription: "At 9:00 AM, Monday through Friday",
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
      "update",
      "schedule-1",
      "--name",
      "Renamed",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      schedules: [
        expect.objectContaining({ id: "schedule-1", name: "Renamed" }),
      ],
    });
    expect(logLines).toEqual([]);
  });

  test("routes IPC failure through exitFromIpcResult", async () => {
    mockIpcResult = { ok: false, error: "Schedule not found" };

    const { exitCode } = await runCommand([
      "schedules",
      "update",
      "missing-schedule",
      "--name",
      "Renamed",
    ]);

    expect(exitCode).toBe(10);
    expect(exitFromIpcResultCalls).toEqual([mockIpcResult]);
    expect(errorLines).toEqual([]);
  });
});

describe("schedules enable/disable", () => {
  test("enable calls toggleSchedule with enabled true", async () => {
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "enable",
      "schedule-1",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "toggleSchedule",
        params: {
          pathParams: { id: "schedule-1" },
          body: { enabled: true },
        },
      },
    ]);
    expect(logLines).toEqual(["Enabled schedule: schedule-1"]);
  });

  test("disable calls toggleSchedule with enabled false", async () => {
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "disable",
      "schedule-1",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "toggleSchedule",
        params: {
          pathParams: { id: "schedule-1" },
          body: { enabled: false },
        },
      },
    ]);
    expect(logLines).toEqual(["Disabled schedule: schedule-1"]);
  });

  test("emits JSON result when --json is set", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        schedules: [
          {
            id: "schedule-1",
            name: "Heartbeat",
            enabled: false,
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
      "disable",
      "schedule-1",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      schedules: [
        expect.objectContaining({ id: "schedule-1", enabled: false }),
      ],
    });
    expect(logLines).toEqual([]);
  });

  test("routes IPC failure through exitFromIpcResult", async () => {
    mockIpcResult = { ok: false, error: "Schedule not found" };

    const { exitCode } = await runCommand([
      "schedules",
      "enable",
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

describe("schedules delete", () => {
  test("calls deleteSchedule with the schedule ID path param when --force is set", async () => {
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "delete",
      "schedule-1",
      "--force",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "deleteSchedule",
        params: { pathParams: { id: "schedule-1" } },
      },
    ]);
    expect(logLines).toEqual(["Deleted schedule: schedule-1"]);
  });

  test("emits JSON result when --json is set with --force", async () => {
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
      "delete",
      "schedule-1",
      "--force",
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
      error: "Schedule not found",
    };

    const { exitCode } = await runCommand([
      "schedules",
      "delete",
      "missing-schedule",
      "--force",
    ]);

    expect(exitCode).toBe(10);
    expect(exitFromIpcResultCalls).toEqual([mockIpcResult]);
    expect(errorLines).toEqual([]);
  });

  test("refuses to delete non-interactively without --force", async () => {
    // bun's test runner attaches a non-TTY stdin, so confirmPrompt takes the
    // non-interactive branch and the IPC is never invoked. This locks in the
    // safety guarantee that scripts must opt in via --force.
    mockIpcResult = { ok: true, result: { schedules: [] } };

    const { exitCode } = await runCommand([
      "schedules",
      "delete",
      "schedule-1",
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toEqual([]);
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
