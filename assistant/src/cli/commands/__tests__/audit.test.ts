/**
 * Tests for the `assistant audit` CLI command.
 *
 * Validates:
 *   - Successful IPC response formats and prints a table row
 *   - --limit flag is forwarded as a queryParam
 *   - Empty invocations list prints "No tool invocations recorded"
 *   - IPC error results in a non-zero exit code
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let ipcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
let mockResponses: Array<{
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
}> = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return mockResponses.shift() ?? { ok: true, result: null };
  },
  exitFromIpcResult: (r: { ok: false; error?: string; statusCode?: number }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = r.statusCode !== undefined && r.statusCode >= 400 ? 2 : 10;
    throw new Error(`process.exit(${process.exitCode})`);
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
    info: (msg: string) => {
      process.stdout.write(msg + "\n");
    },
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerAuditCommand } = await import("../audit.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerAuditCommand(program);
    await program.parseAsync(["node", "assistant", "audit", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeInvocation(
  overrides: Partial<{
    createdAt: number;
    toolName: string;
    input: string;
    decision: string;
    riskLevel: string;
    durationMs: number;
  }> = {},
) {
  return {
    createdAt: Date.now(),
    toolName: "bash",
    input: JSON.stringify({ command: "ls -la" }),
    decision: "allow",
    riskLevel: "low",
    durationMs: 42,
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
// Tests
// ---------------------------------------------------------------------------

describe("audit command — success", () => {
  test("stdout contains tool name and decision from returned invocations", async () => {
    mockResponses.push({
      ok: true,
      result: { invocations: [makeInvocation()] },
    });

    const { stdout, exitCode } = await runCommand([]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("bash");
    expect(stdout).toContain("allow");
  });

  test("--limit 5 forwards queryParams with limit=5", async () => {
    mockResponses.push({
      ok: true,
      result: { invocations: [] },
    });

    await runCommand(["--limit", "5"]);

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0].method).toBe("audit_recent_invocations");
    expect((ipcCalls[0].params as { queryParams: Record<string, string> }).queryParams).toEqual({ limit: "5" });
  });
});

describe("audit command — empty results", () => {
  test("stdout contains 'No tool invocations recorded' when list is empty", async () => {
    mockResponses.push({
      ok: true,
      result: { invocations: [] },
    });

    const { stdout, exitCode } = await runCommand([]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("No tool invocations recorded");
  });
});

describe("audit command — IPC error", () => {
  test("exits non-zero on IPC failure", async () => {
    mockResponses.push({
      ok: false,
      error: "Connection refused",
    });

    const { exitCode } = await runCommand([]);

    expect(exitCode).not.toBe(0);
  });
});
