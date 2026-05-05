/**
 * Tests for the `assistant gateway logs tail` CLI command.
 *
 * Validates:
 *   - Default invocation calls IPC with { n: 10 } (no level or module)
 *   - -n flag changes the line count
 *   - --level flag forwards the level param
 *   - --module flag forwards the module param
 *   - Pretty-print output includes TIME/LEVEL/MODULE/MESSAGE header and entry data
 *   - -q flag suppresses the header row
 *   - --raw outputs one JSON object per line, no header
 *   - Zero results shows "No log entries found."
 *   - truncated: true shows the footer line
 *   - IPC failure sets process.exitCode = 1
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** All `cliIpcCall` invocations captured for assertions. */
let ipcCalls: Array<{ method: string; params?: any }> = [];

/**
 * Queue of responses for cliIpcCall. Each call pops from the front.
 * When the queue is empty, defaults to { ok: true, result: null }.
 */
let mockResponses: Array<{
  ok: boolean;
  result?: unknown;
  error?: string;
}> = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return mockResponses.shift() ?? { ok: true, result: null };
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

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerGatewayCommand } = await import("../gateway.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

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
    registerGatewayCommand(program);
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePinoEntry(
  overrides: Partial<{
    time: number;
    level: number;
    module: string;
    msg: string;
  }> = {},
) {
  return {
    time: 1700000000000,
    level: 30,
    module: "gateway",
    msg: "Request handled",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  ipcCalls = [];
  mockResponses = [];
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// IPC params
// ---------------------------------------------------------------------------

describe("gateway logs tail — IPC params", () => {
  test("default (no flags): IPC called with { n: 10 } only — no level or module key", async () => {
    mockResponses.push({ ok: true, result: { lines: [], truncated: false } });

    await runCommand(["gateway", "logs", "tail"]);

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0].method).toBe("gateway_logs_tail");
    expect(ipcCalls[0].params?.body).toEqual({ n: 10 });
  });

  test("-n 25: IPC called with { n: 25 }", async () => {
    mockResponses.push({ ok: true, result: { lines: [], truncated: false } });

    await runCommand(["gateway", "logs", "tail", "-n", "25"]);

    expect(ipcCalls[0].params?.body).toEqual({ n: 25 });
  });

  test("--level error: IPC called with { n: 10, level: 'error' }", async () => {
    mockResponses.push({ ok: true, result: { lines: [], truncated: false } });

    await runCommand(["gateway", "logs", "tail", "--level", "error"]);

    expect(ipcCalls[0].params?.body).toEqual({ n: 10, level: "error" });
  });

  test("--module mcp: IPC called with { n: 10, module: 'mcp' }", async () => {
    mockResponses.push({ ok: true, result: { lines: [], truncated: false } });

    await runCommand(["gateway", "logs", "tail", "--module", "mcp"]);

    expect(ipcCalls[0].params?.body).toEqual({ n: 10, module: "mcp" });
  });
});

// ---------------------------------------------------------------------------
// Pretty-print output
// ---------------------------------------------------------------------------

describe("gateway logs tail — pretty-print", () => {
  test("output contains TIME/LEVEL/MODULE/MESSAGE header and entry data", async () => {
    const entry = makePinoEntry({ msg: "hello world", module: "router" });
    mockResponses.push({
      ok: true,
      result: { lines: [entry], truncated: false },
    });

    const { stdout } = await runCommand(["gateway", "logs", "tail"]);

    expect(stdout).toContain("TIME");
    expect(stdout).toContain("LEVEL");
    expect(stdout).toContain("MODULE");
    expect(stdout).toContain("MESSAGE");
    expect(stdout).toContain("hello world");
    expect(stdout).toContain("router");
  });

  test("-q flag: stdout does NOT contain header row (TIME absent)", async () => {
    const entry = makePinoEntry({ msg: "silent entry" });
    mockResponses.push({
      ok: true,
      result: { lines: [entry], truncated: false },
    });

    const { stdout } = await runCommand(["gateway", "logs", "tail", "-q"]);

    expect(stdout).not.toContain("TIME");
    expect(stdout).not.toContain("LEVEL");
    expect(stdout).not.toContain("MODULE");
    expect(stdout).not.toContain("MESSAGE");
    expect(stdout).toContain("silent entry");
  });

  test("zero results: stdout contains 'No log entries found.'", async () => {
    mockResponses.push({
      ok: true,
      result: { lines: [], truncated: false },
    });

    const { stdout, exitCode } = await runCommand(["gateway", "logs", "tail"]);

    expect(stdout).toContain("No log entries found.");
    expect(exitCode).toBe(0);
  });

  test("truncated: true — stdout contains 'earlier entries exist' footer", async () => {
    const entry = makePinoEntry();
    mockResponses.push({
      ok: true,
      result: { lines: [entry], truncated: true },
    });

    const { stdout } = await runCommand(["gateway", "logs", "tail"]);

    expect(stdout).toContain("earlier entries exist");
  });
});

// ---------------------------------------------------------------------------
// Raw output
// ---------------------------------------------------------------------------

describe("gateway logs tail — --raw", () => {
  test("--raw: stdout is valid JSON per line; no header", async () => {
    const entry = makePinoEntry({ msg: "raw entry" });
    mockResponses.push({
      ok: true,
      result: { lines: [entry], truncated: false },
    });

    const { stdout } = await runCommand(["gateway", "logs", "tail", "--raw"]);

    // No table header
    expect(stdout).not.toContain("TIME");

    // Each non-empty line is valid JSON
    const lines = stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toBeDefined();
    }

    // The entry data is present
    const parsed = JSON.parse(lines[0]);
    expect(parsed.msg).toBe("raw entry");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("gateway logs tail — error handling", () => {
  test("IPC failure sets process.exitCode = 1", async () => {
    mockResponses.push({ ok: false, error: "daemon not running" });

    const { exitCode } = await runCommand(["gateway", "logs", "tail"]);

    expect(exitCode).toBe(1);
  });
});
