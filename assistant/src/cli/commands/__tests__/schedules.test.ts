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

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return mockIpcResult;
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
  mockIpcResult = { ok: true, result: { schedules: [] } };
  process.exitCode = 0;
});

describe("schedules command", () => {
  test("registers the list subcommand only", () => {
    const program = new Command();
    registerSchedulesCommand(program);

    const schedules = program.commands.find(
      (command) => command.name() === "schedules",
    );
    expect(schedules).toBeDefined();
    expect(schedules!.commands.map((command) => command.name())).toEqual([
      "list",
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

  test("passes include_all when --include-all is set", async () => {
    await runCommand(["schedules", "list", "--include-all"]);

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
