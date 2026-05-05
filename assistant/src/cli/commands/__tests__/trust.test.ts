/**
 * Tests for the `assistant trust` CLI command.
 *
 * Validates:
 *   - Subcommand registration (list)
 *   - `list` sends correct IPC method and params
 *   - `list` with --tool filters by tool name
 *   - `list` with --all includes unmodified defaults
 *   - `--json` flag outputs structured JSON
 *   - IPC error results in exit code 1
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

const { registerTrustCommand } = await import("../trust.js");

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
    registerTrustCommand(program);
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

function makeTrustRule(
  overrides: Partial<{
    id: string;
    tool: string;
    pattern: string;
    risk: string;
    origin: string;
    userModified: boolean;
    updatedAt: string;
  }> = {},
) {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    tool: "bash",
    pattern: "ls .*",
    risk: "low",
    origin: "user",
    userModified: true,
    updatedAt: "2024-01-15T10:00:00Z",
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
// Subcommand registration
// ---------------------------------------------------------------------------

describe("subcommand registration", () => {
  test("registers list subcommand under trust", () => {
    const program = new Command();
    registerTrustCommand(program);
    const trust = program.commands.find((c) => c.name() === "trust");
    expect(trust).toBeDefined();
    const subcommandNames = trust!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual(["list"]);
  });
});

// ---------------------------------------------------------------------------
// trust list
// ---------------------------------------------------------------------------

describe("trust list", () => {
  test("sends trust_rules_list with empty params by default", async () => {
    mockResponses.push({ ok: true, result: { rules: [] } });

    const { exitCode } = await runCommand(["trust", "list"]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0].method).toBe("trust_rules_list");
    expect(ipcCalls[0].params.body).toEqual({});
  });

  test("--tool adds tool param", async () => {
    mockResponses.push({ ok: true, result: { rules: [] } });

    await runCommand(["trust", "list", "--tool", "bash"]);

    expect(ipcCalls[0].method).toBe("trust_rules_list");
    expect(ipcCalls[0].params.body).toEqual({ tool: "bash" });
  });

  test("--all adds include_all: true", async () => {
    mockResponses.push({ ok: true, result: { rules: [] } });

    await runCommand(["trust", "list", "--all"]);

    expect(ipcCalls[0].method).toBe("trust_rules_list");
    expect(ipcCalls[0].params.body).toEqual({ include_all: true });
  });

  test("--all and --tool can be combined", async () => {
    mockResponses.push({ ok: true, result: { rules: [] } });

    await runCommand(["trust", "list", "--all", "--tool", "bash"]);

    expect(ipcCalls[0].params.body).toEqual({
      include_all: true,
      tool: "bash",
    });
  });

  test("--json outputs structured JSON on success", async () => {
    const rule = makeTrustRule();
    mockResponses.push({ ok: true, result: { rules: [rule] } });

    const { exitCode, stdout } = await runCommand(["trust", "list", "--json"]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.rules).toBeArray();
    expect(parsed.data.rules[0].id).toBe(rule.id);
  });

  test("IPC error results in exit code 1", async () => {
    mockResponses.push({ ok: false, error: "Connection refused" });

    const { exitCode } = await runCommand(["trust", "list"]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs error on IPC failure", async () => {
    mockResponses.push({ ok: false, error: "Connection refused" });

    const { exitCode, stdout } = await runCommand(["trust", "list", "--json"]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Connection refused");
  });
});
