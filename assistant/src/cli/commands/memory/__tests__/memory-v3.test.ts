/**
 * Tests for the `assistant memory v3` CLI subgroup (section-lane model).
 *
 * Validates:
 *   - Subcommand registration (rebuild-index, backfill-sections) under
 *     `memory v3`.
 *   - Each subcommand maps to the right `cliIpcCall` method.
 *   - `backfill-sections` passes a long IPC timeout (the one-time full-corpus
 *     embed easily outlasts the default 60s), while `rebuild-index` does not.
 *   - IPC error paths return a non-zero exit code without throwing.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: {
  method: string;

  params?: any;
  options?: { timeoutMs?: number; signal?: AbortSignal };
} | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: { articles: 3, sections: 12, failures: 0 } };

/** Captured log output for assertion. */
let logOutput: string[] = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (
    method: string,
    params?: any,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => {
    lastIpcCall = { method, params, options };
    return mockIpcResult;
  },
}));

const capture = (...args: unknown[]) => {
  logOutput.push(args.map(String).join(" "));
};
const fakeLogger = {
  info: capture,
  warn: capture,
  error: capture,
  debug: () => {},
};
mock.module("../../../../util/logger.js", () => ({
  getLogger: () => fakeLogger,
  getCliLogger: () => fakeLogger,
}));

// ---------------------------------------------------------------------------
// Import modules under test (after mocks)
// ---------------------------------------------------------------------------

const { registerMemoryV3Command } = await import("../memory-v3.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  const memory = program.command("memory");
  registerMemoryV3Command(memory);
  return program;
}

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = (() => true) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = buildProgram();
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return { exitCode, stdout: stdoutChunks.join("") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = {
    ok: true,
    result: { articles: 3, sections: 12, failures: 0 },
  };
  logOutput = [];
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Subcommand registration
// ---------------------------------------------------------------------------

describe("subcommand registration", () => {
  test("registers v3 under memory with the expected subcommands", () => {
    const program = buildProgram();
    const memory = program.commands.find((c) => c.name() === "memory");
    expect(memory).toBeDefined();
    const v3 = memory!.commands.find((c) => c.name() === "v3");
    expect(v3).toBeDefined();
    const subcommandNames = v3!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual([
      "backfill-sections",
      "eval",
      "eval-tally",
      "rebuild-index",
    ]);
  });
});

// ---------------------------------------------------------------------------
// rebuild-index
// ---------------------------------------------------------------------------

describe("memory v3 rebuild-index", () => {
  test("sends memory_v3_rebuild_index with the default (no) timeout", async () => {
    mockIpcResult = { ok: true, result: { invalidated: true } };

    const { exitCode } = await runCommand(["memory", "v3", "rebuild-index"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("memory_v3_rebuild_index");
    expect(lastIpcCall!.params!.body).toEqual({});
    // rebuild-index is fast; it relies on the default call timeout.
    expect(lastIpcCall!.options).toBeUndefined();
  });

  test("exits with code 1 on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Daemon down" };

    const { exitCode } = await runCommand(["memory", "v3", "rebuild-index"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// backfill-sections
// ---------------------------------------------------------------------------

describe("memory v3 backfill-sections", () => {
  test("sends memory_v3_backfill_sections with a long (30-min) IPC timeout", async () => {
    mockIpcResult = {
      ok: true,
      result: { articles: 50, sections: 400, failures: 0 },
    };

    const { exitCode } = await runCommand([
      "memory",
      "v3",
      "backfill-sections",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("memory_v3_backfill_sections");
    expect(lastIpcCall!.params!.body).toEqual({});
    // The one-time full-corpus embed is long-running, so the CLI must override
    // the default 60s timeout with a generous ceiling (30 min).
    expect(lastIpcCall!.options!.timeoutMs).toBe(30 * 60 * 1000);
  });

  test("summarizes embedded sections on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { articles: 7, sections: 42, failures: 0 },
    };

    await runCommand(["memory", "v3", "backfill-sections"]);

    expect(
      logOutput.some((line) => line.includes("42") && line.includes("7")),
    ).toBe(true);
  });

  test("exits with code 1 on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Memory v3 not enabled" };

    const { exitCode } = await runCommand([
      "memory",
      "v3",
      "backfill-sections",
    ]);

    expect(exitCode).toBe(1);
  });
});
