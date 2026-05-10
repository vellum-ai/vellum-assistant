/**
 * Tests for the `assistant usage` CLI command.
 *
 * Validates:
 *   - usage totals → cliIpcCall("usage_totals", ...) with queryParams from/to
 *   - usage totals --range today → from is approximately today's midnight
 *   - usage daily → cliIpcCall("usage_daily", ...) called
 *   - usage breakdown --group-by provider → cliIpcCall("usage_breakdown", ...) with groupBy
 *   - invalid --group-by xyz → process exits with error before IPC call
 *   - IPC error → exit non-zero
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let lastIpcCall: {
  method: string;
  params?: any;
} | null = null;

let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = { ok: true, result: {} };

const logLines: string[] = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitFromIpcResult: (r: { ok: false; error?: string; statusCode?: number }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = r.statusCode !== undefined && r.statusCode >= 400 ? 2 : 10;
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
    warn: (message: string) => logLines.push(message),
    error: (message: string) => logLines.push(message),
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerUsageCommand } = await import("../usage.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ exitCode: number }> {
  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
    registerUsageCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return { exitCode };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: {} };
  logLines.length = 0;
  process.exitCode = 0;
});

// ===========================================================================
// usage totals
// ===========================================================================

describe("usage totals", () => {
  test("calls usage_totals IPC with queryParams from and to", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalEstimatedCostUsd: 0.01,
        eventCount: 5,
        pricedEventCount: 5,
        unpricedEventCount: 0,
      },
    };

    const { exitCode } = await runCommand(["usage", "totals"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("usage_totals");
    expect(lastIpcCall!.params).toBeDefined();
    expect(lastIpcCall!.params!.queryParams).toBeDefined();
    expect(lastIpcCall!.params!.queryParams.from).toBeDefined();
    expect(lastIpcCall!.params!.queryParams.to).toBeDefined();
    // from and to should be numeric strings
    expect(Number.isFinite(Number(lastIpcCall!.params!.queryParams.from))).toBe(true);
    expect(Number.isFinite(Number(lastIpcCall!.params!.queryParams.to))).toBe(true);
  });

  test("usage totals --range today passes from at approximately today's midnight", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalEstimatedCostUsd: 0,
        eventCount: 0,
        pricedEventCount: 0,
        unpricedEventCount: 0,
      },
    };

    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const expectedFrom = startOfToday.getTime();

    const { exitCode } = await runCommand(["usage", "totals", "--range", "today"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("usage_totals");
    const actualFrom = Number(lastIpcCall!.params!.queryParams.from);
    // Should be within 5 seconds of today's midnight (allow for test execution time)
    expect(Math.abs(actualFrom - expectedFrom)).toBeLessThan(5000);
  });

  test("usage totals --range all passes from=0", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalEstimatedCostUsd: 0,
        eventCount: 0,
        pricedEventCount: 0,
        unpricedEventCount: 0,
      },
    };

    const { exitCode } = await runCommand(["usage", "totals", "--range", "all"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.queryParams.from).toBe("0");
  });

  test("IPC error exits non-zero", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand(["usage", "totals"]);

    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// usage daily
// ===========================================================================

describe("usage daily", () => {
  test("calls usage_daily IPC with queryParams from and to", async () => {
    mockIpcResult = {
      ok: true,
      result: { buckets: [] },
    };

    const { exitCode } = await runCommand(["usage", "daily"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("usage_daily");
    expect(lastIpcCall!.params!.queryParams).toBeDefined();
    expect(lastIpcCall!.params!.queryParams.from).toBeDefined();
    expect(lastIpcCall!.params!.queryParams.to).toBeDefined();
  });

  test("usage daily --range week passes a from value 7+ days ago", async () => {
    mockIpcResult = {
      ok: true,
      result: { buckets: [] },
    };

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const { exitCode } = await runCommand(["usage", "daily", "--range", "week"]);

    expect(exitCode).toBe(0);
    const actualFrom = Number(lastIpcCall!.params!.queryParams.from);
    // Should be approximately 7 days ago (within a minute)
    expect(Math.abs(actualFrom - sevenDaysAgo)).toBeLessThan(60_000);
  });

  test("IPC error exits non-zero", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand(["usage", "daily"]);

    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// usage breakdown
// ===========================================================================

describe("usage breakdown", () => {
  test("calls usage_breakdown with groupBy=provider", async () => {
    mockIpcResult = {
      ok: true,
      result: { breakdown: [] },
    };

    const { exitCode } = await runCommand([
      "usage",
      "breakdown",
      "--group-by",
      "provider",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("usage_breakdown");
    expect(lastIpcCall!.params!.queryParams).toBeDefined();
    expect(lastIpcCall!.params!.queryParams.groupBy).toBe("provider");
    expect(lastIpcCall!.params!.queryParams.from).toBeDefined();
    expect(lastIpcCall!.params!.queryParams.to).toBeDefined();
  });

  test("calls usage_breakdown with groupBy=call_site", async () => {
    mockIpcResult = {
      ok: true,
      result: { breakdown: [] },
    };

    const { exitCode } = await runCommand([
      "usage",
      "breakdown",
      "--group-by",
      "call_site",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.queryParams.groupBy).toBe("call_site");
  });

  test("invalid --group-by exits with error before making IPC call", async () => {
    const { exitCode } = await runCommand([
      "usage",
      "breakdown",
      "--group-by",
      "xyz",
    ]);

    expect(exitCode).not.toBe(0);
    // IPC should NOT have been called
    expect(lastIpcCall).toBeNull();
  });

  test("IPC error exits non-zero", async () => {
    mockIpcResult = { ok: false, error: "Connection refused", statusCode: 500 };

    const { exitCode } = await runCommand([
      "usage",
      "breakdown",
      "--group-by",
      "model",
    ]);

    expect(exitCode).not.toBe(0);
  });
});


// ===========================================================================
// usage breakdown — output rendering (mock IPC, capture log)
// ===========================================================================

describe("usage breakdown — output rendering", () => {
  test("--json passes through group and groupKey from IPC result", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        breakdown: [
          {
            group: "Main Agent",
            groupId: "mainAgent",
            groupKey: "mainAgent",
            totalInputTokens: 100,
            totalOutputTokens: 50,
            totalCacheCreationTokens: 0,
            totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0.01,
            eventCount: 1,
          },
          {
            group: "Unknown Task",
            groupId: null,
            groupKey: null,
            totalInputTokens: 200,
            totalOutputTokens: 100,
            totalCacheCreationTokens: 0,
            totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0.005,
            eventCount: 1,
          },
        ],
      },
    };

    const { exitCode } = await runCommand([
      "usage",
      "breakdown",
      "--range",
      "all",
      "--group-by",
      "call_site",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("usage_breakdown");
    expect(lastIpcCall!.params!.queryParams.groupBy).toBe("call_site");

    const output = logLines.join("\n");
    const parsed = JSON.parse(output) as {
      breakdown: Array<{ group: string; groupKey: string | null }>;
    };
    expect(parsed.breakdown.map((row) => row.group)).toEqual([
      "Main Agent",
      "Unknown Task",
    ]);
    expect(parsed.breakdown.map((row) => row.groupKey)).toEqual([
      "mainAgent",
      null,
    ]);
  });

  test("table renders PROFILE header and pass-through Default / Unset row for inference_profile", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        breakdown: [
          {
            group: "Default / Unset",
            groupId: null,
            groupKey: null,
            totalInputTokens: 100,
            totalOutputTokens: 50,
            totalCacheCreationTokens: 0,
            totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0.01,
            eventCount: 1,
          },
        ],
      },
    };

    const { exitCode } = await runCommand([
      "usage",
      "breakdown",
      "--range",
      "all",
      "--group-by",
      "inference_profile",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.queryParams.groupBy).toBe("inference_profile");

    const output = logLines.join("\n");
    expect(output).toContain("PROFILE");
    expect(output).toContain("Default / Unset");
  });
});
