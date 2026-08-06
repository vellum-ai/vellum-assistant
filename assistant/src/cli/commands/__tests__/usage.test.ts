import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let ipcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: {} };
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
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { registerUsageCommand } = await import("../usage.js");

async function runCommand(args: string[]): Promise<{ exitCode: number }> {
  process.exitCode = 0;
  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
    registerUsageCommand(program);
    await program.parseAsync(["node", "assistant", "usage", ...args]);
  } catch {
    if (process.exitCode === 0) {
      process.exitCode = 1;
    }
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  return { exitCode };
}

function lastQueryParams(): Record<string, unknown> {
  const call = ipcCalls.at(-1);
  return (call?.params?.queryParams ?? {}) as Record<string, unknown>;
}

describe("usage --schedule option", () => {
  beforeEach(() => {
    ipcCalls = [];
    exitFromIpcResultCalls = [];
    mockIpcResult = { ok: true, result: {} };
  });

  test("totals forwards --schedule as scheduleId", async () => {
    mockIpcResult = { ok: true, result: { buckets: [] } };
    await runCommand([
      "totals",
      "--range",
      "all",
      "--schedule",
      "sched-abc123",
    ]);
    expect(ipcCalls.at(-1)?.method).toBe("usage_totals");
    expect(lastQueryParams().scheduleId).toBe("sched-abc123");
  });

  test("totals omits scheduleId when --schedule absent", async () => {
    await runCommand(["totals", "--range", "all"]);
    expect(ipcCalls.at(-1)?.method).toBe("usage_totals");
    expect(lastQueryParams()).not.toHaveProperty("scheduleId");
  });

  test("daily forwards --schedule as scheduleId", async () => {
    mockIpcResult = { ok: true, result: { buckets: [] } };
    await runCommand(["daily", "--range", "all", "--schedule", "sched-abc123"]);
    expect(ipcCalls.at(-1)?.method).toBe("usage_daily");
    expect(lastQueryParams().scheduleId).toBe("sched-abc123");
  });

  test("daily omits scheduleId when --schedule absent", async () => {
    mockIpcResult = { ok: true, result: { buckets: [] } };
    await runCommand(["daily", "--range", "all"]);
    expect(ipcCalls.at(-1)?.method).toBe("usage_daily");
    expect(lastQueryParams()).not.toHaveProperty("scheduleId");
  });

  test("breakdown forwards --schedule as scheduleId alongside groupBy", async () => {
    mockIpcResult = { ok: true, result: { breakdown: [] } };
    await runCommand([
      "breakdown",
      "--range",
      "all",
      "--group-by",
      "provider",
      "--schedule",
      "sched-abc123",
    ]);
    expect(ipcCalls.at(-1)?.method).toBe("usage_breakdown");
    const qp = lastQueryParams();
    expect(qp.scheduleId).toBe("sched-abc123");
    expect(qp.groupBy).toBe("provider");
  });

  test("breakdown omits scheduleId when --schedule absent", async () => {
    mockIpcResult = { ok: true, result: { breakdown: [] } };
    await runCommand(["breakdown", "--range", "all", "--group-by", "provider"]);
    expect(ipcCalls.at(-1)?.method).toBe("usage_breakdown");
    expect(lastQueryParams()).not.toHaveProperty("scheduleId");
  });
});
