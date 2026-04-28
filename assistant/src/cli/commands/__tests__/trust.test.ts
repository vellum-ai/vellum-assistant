/**
 * Tests for the `assistant trust` CLI command.
 *
 * Validates:
 *   - Subcommand registration (list, add, update, remove)
 *   - `list` sends correct IPC method and params
 *   - `list` with --tool filters by tool name
 *   - `list` with --all includes unmodified defaults
 *   - `add` sends correct IPC method and params
 *   - `add` validates --risk before making IPC call
 *   - `update` resolves ID prefix via list call, then updates
 *   - `update` exits 1 on ambiguous prefix, no match, or missing opts
 *   - `remove` resolves ID prefix via list call, then removes
 *   - `remove` exits 1 on ambiguous prefix or no match
 *   - `--json` flag outputs structured JSON for each subcommand
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

function makeTrustRule(overrides: Partial<{
  id: string;
  tool: string;
  pattern: string;
  risk: string;
  origin: string;
  userModified: boolean;
  updatedAt: string;
}> = {}) {
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
  test("registers list, add, update, remove subcommands under trust", () => {
    const program = new Command();
    registerTrustCommand(program);
    const trust = program.commands.find((c) => c.name() === "trust");
    expect(trust).toBeDefined();
    const subcommandNames = trust!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual(["add", "list", "remove", "update"]);
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

    expect(ipcCalls[0].params.body).toEqual({ include_all: true, tool: "bash" });
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

    const { exitCode, stdout } = await runCommand([
      "trust",
      "list",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Connection refused");
  });
});

// ---------------------------------------------------------------------------
// trust add
// ---------------------------------------------------------------------------

describe("trust add", () => {
  test("sends trust_rules_create with all required fields", async () => {
    const rule = makeTrustRule();
    mockResponses.push({ ok: true, result: { rule } });

    const { exitCode } = await runCommand([
      "trust",
      "add",
      "--tool",
      "bash",
      "--pattern",
      "ls .*",
      "--risk",
      "low",
      "--description",
      "Directory listing",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0].method).toBe("trust_rules_create");
    expect(ipcCalls[0].params.body.tool).toBe("bash");
    expect(ipcCalls[0].params.body.pattern).toBe("ls .*");
    expect(ipcCalls[0].params.body.risk).toBe("low");
    expect(ipcCalls[0].params.body.description).toBe("Directory listing");
  });

  test("invalid --risk exits 1 without making IPC call", async () => {
    const { exitCode } = await runCommand([
      "trust",
      "add",
      "--tool",
      "bash",
      "--pattern",
      "ls .*",
      "--risk",
      "extreme",
      "--description",
      "test",
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toHaveLength(0);
  });

  test("IPC error results in exit code 1", async () => {
    mockResponses.push({ ok: false, error: "Invalid tool name" });

    const { exitCode } = await runCommand([
      "trust",
      "add",
      "--tool",
      "bash",
      "--pattern",
      "ls .*",
      "--risk",
      "low",
      "--description",
      "test",
    ]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs structured JSON on success", async () => {
    const rule = makeTrustRule();
    mockResponses.push({ ok: true, result: { rule } });

    const { exitCode, stdout } = await runCommand([
      "trust",
      "add",
      "--tool",
      "bash",
      "--pattern",
      "ls .*",
      "--risk",
      "low",
      "--description",
      "Directory listing",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.rule.id).toBe(rule.id);
  });

  test("--json outputs error on IPC failure", async () => {
    mockResponses.push({ ok: false, error: "Invalid tool name" });

    const { exitCode, stdout } = await runCommand([
      "trust",
      "add",
      "--tool",
      "bash",
      "--pattern",
      "ls .*",
      "--risk",
      "low",
      "--description",
      "test",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Invalid tool name");
  });

  test("--json outputs error on invalid --risk", async () => {
    const { exitCode, stdout } = await runCommand([
      "trust",
      "add",
      "--tool",
      "bash",
      "--pattern",
      "ls .*",
      "--risk",
      "extreme",
      "--description",
      "test",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("extreme");
  });
});

// ---------------------------------------------------------------------------
// trust update
// ---------------------------------------------------------------------------

describe("trust update", () => {
  const fullId = "abc-111-aaaa-bbbb-cccc-dddddddddddd";
  const rule = makeTrustRule({ id: fullId });

  test("resolves prefix, sends trust_rules_list then trust_rules_update", async () => {
    mockResponses.push({ ok: true, result: { rules: [rule] } });
    mockResponses.push({ ok: true, result: { rule: { ...rule, risk: "medium" } } });

    const { exitCode } = await runCommand([
      "trust",
      "update",
      "abc",
      "--risk",
      "medium",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toHaveLength(2);
    expect(ipcCalls[0].method).toBe("trust_rules_list");
    expect(ipcCalls[0].params.body).toEqual({ include_all: true });
    expect(ipcCalls[1].method).toBe("trust_rules_update");
    expect(ipcCalls[1].params.body.id).toBe(fullId);
    expect(ipcCalls[1].params.body.risk).toBe("medium");
  });

  test("sends description when --description is provided", async () => {
    mockResponses.push({ ok: true, result: { rules: [rule] } });
    mockResponses.push({ ok: true, result: { rule } });

    await runCommand([
      "trust",
      "update",
      "abc",
      "--description",
      "new description",
    ]);

    expect(ipcCalls[1].params.body.description).toBe("new description");
    expect(ipcCalls[1].params.body.risk).toBeUndefined();
  });

  test("ambiguous prefix exits 1 and does not call update", async () => {
    const rule1 = makeTrustRule({
      id: "abc-111-aaaa-bbbb-cccc-dddddddddddd",
    });
    const rule2 = makeTrustRule({
      id: "abc-222-aaaa-bbbb-cccc-dddddddddddd",
      tool: "file_write",
    });
    mockResponses.push({ ok: true, result: { rules: [rule1, rule2] } });

    const { exitCode } = await runCommand([
      "trust",
      "update",
      "abc",
      "--risk",
      "high",
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toHaveLength(1); // only the list call
  });

  test("no match exits 1 and does not call update", async () => {
    mockResponses.push({ ok: true, result: { rules: [rule] } });

    const { exitCode } = await runCommand([
      "trust",
      "update",
      "zzz",
      "--risk",
      "high",
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toHaveLength(1); // only the list call
  });

  test("missing --risk and --description exits 1 without any IPC calls", async () => {
    const { exitCode } = await runCommand(["trust", "update", "abc"]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toHaveLength(0);
  });

  test("IPC error on list exits 1", async () => {
    mockResponses.push({ ok: false, error: "Connection refused" });

    const { exitCode } = await runCommand([
      "trust",
      "update",
      "abc",
      "--risk",
      "low",
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toHaveLength(1);
  });

  test("IPC error on update exits 1", async () => {
    mockResponses.push({ ok: true, result: { rules: [rule] } });
    mockResponses.push({ ok: false, error: "Rule not found" });

    const { exitCode } = await runCommand([
      "trust",
      "update",
      "abc",
      "--risk",
      "low",
    ]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs structured JSON on success", async () => {
    const updatedRule = { ...rule, risk: "high" };
    mockResponses.push({ ok: true, result: { rules: [rule] } });
    mockResponses.push({ ok: true, result: { rule: updatedRule } });

    const { exitCode, stdout } = await runCommand([
      "trust",
      "update",
      "abc",
      "--risk",
      "high",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.rule.risk).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// trust remove
// ---------------------------------------------------------------------------

describe("trust remove", () => {
  const fullId = "abc-111-aaaa-bbbb-cccc-dddddddddddd";
  const rule = makeTrustRule({ id: fullId });

  test("resolves prefix, sends trust_rules_list then trust_rules_remove", async () => {
    mockResponses.push({ ok: true, result: { rules: [rule] } });
    mockResponses.push({ ok: true, result: { success: true } });

    const { exitCode } = await runCommand(["trust", "remove", "abc"]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toHaveLength(2);
    expect(ipcCalls[0].method).toBe("trust_rules_list");
    expect(ipcCalls[0].params.body).toEqual({ include_all: true });
    expect(ipcCalls[1].method).toBe("trust_rules_remove");
    expect(ipcCalls[1].params.body).toEqual({ id: fullId });
  });

  test("ambiguous prefix exits 1 and does not call remove", async () => {
    const rule1 = makeTrustRule({
      id: "abc-111-aaaa-bbbb-cccc-dddddddddddd",
    });
    const rule2 = makeTrustRule({
      id: "abc-222-aaaa-bbbb-cccc-dddddddddddd",
      tool: "file_write",
    });
    mockResponses.push({ ok: true, result: { rules: [rule1, rule2] } });

    const { exitCode } = await runCommand(["trust", "remove", "abc"]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toHaveLength(1); // only the list call
  });

  test("no match exits 1 and does not call remove", async () => {
    mockResponses.push({ ok: true, result: { rules: [rule] } });

    const { exitCode } = await runCommand(["trust", "remove", "zzz"]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toHaveLength(1); // only the list call
  });

  test("IPC error on list exits 1", async () => {
    mockResponses.push({ ok: false, error: "Connection refused" });

    const { exitCode } = await runCommand(["trust", "remove", "abc"]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toHaveLength(1);
  });

  test("IPC error on remove exits 1", async () => {
    mockResponses.push({ ok: true, result: { rules: [rule] } });
    mockResponses.push({ ok: false, error: "Rule not found" });

    const { exitCode } = await runCommand(["trust", "remove", "abc"]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs structured JSON on success", async () => {
    mockResponses.push({ ok: true, result: { rules: [rule] } });
    mockResponses.push({ ok: true, result: { success: true } });

    const { exitCode, stdout } = await runCommand([
      "trust",
      "remove",
      "abc",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.success).toBe(true);
    expect(parsed.data.id).toBe(fullId);
  });
});
