/**
 * Tests for the `assistant memory v2` CLI subgroup.
 *
 * Validates:
 *   - Subcommand registration (reembed, reembed-skills, activation, validate,
 *     ema, simulate) under `memory v2`. v1 had its own subcommands but those
 *     were retired.
 *   - Each mutating subcommand maps to the right `memory_v2_backfill` op.
 *   - `validate` calls `memory_v2_validate` and pretty-prints the report.
 *   - `reembed-skills` calls `memory_v2_reembed_skills` synchronously.
 *   - IPC error paths return a non-zero exit code without throwing.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import { applyCommandHelp } from "../../../lib/cli-command-help.js";
import { memoryHelp } from "../index.help.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: {
  method: string;

  params?: any;
} | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: { jobId: "job-123" } };

/** Captured log output for assertion. */
let logOutput: string[] = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: any) => {
    lastIpcCall = { method, params };
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

const { registerMemoryV2Command } = await import("../memory-v2.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh program with a `memory` parent and register the v2 subgroup
 * under it — mirroring how `registerMemoryCommand` wires the namespace.
 */
function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  const memory = program.command("memory");
  applyCommandHelp(memory, memoryHelp);
  registerMemoryV2Command(memory);
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
  mockIpcResult = { ok: true, result: { jobId: "job-123" } };
  logOutput = [];
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Subcommand registration
// ---------------------------------------------------------------------------

describe("subcommand registration", () => {
  test("registers v2 under memory with the expected subcommands", () => {
    const program = buildProgram();
    const memory = program.commands.find((c) => c.name() === "memory");
    expect(memory).toBeDefined();
    const v2 = memory!.commands.find((c) => c.name() === "v2");
    expect(v2).toBeDefined();
    const subcommandNames = v2!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual([
      "activation",
      "compare",
      "ema",
      "reembed",
      "reembed-skills",
      "simulate",
      "validate",
    ]);
  });

  test("--help lists every registered subcommand and no removed ones", () => {
    const program = buildProgram();
    const memory = program.commands.find((c) => c.name() === "memory")!;
    const v2 = memory.commands.find((c) => c.name() === "v2")!;
    const help = v2.helpInformation();
    expect(help).toContain("reembed");
    expect(help).toContain("reembed-skills");
    expect(help).toContain("activation");
    expect(help).toContain("validate");
    expect(help).toContain("simulate");
    // Removed subcommands must not surface in help.
    expect(help).not.toContain("migrate");
    expect(help).not.toContain("explain");
    expect(help).not.toContain("fit-anisotropy");
    expect(help).not.toContain("rebuild-corpus-stats");
    expect(help).not.toContain("rebuild-edges");
  });
});

// ---------------------------------------------------------------------------
// reembed
// ---------------------------------------------------------------------------

describe("memory v2 reembed", () => {
  test("sends memory_v2/backfill with op=reembed", async () => {
    mockIpcResult = { ok: true, result: { jobId: "reembed-1" } };

    const { exitCode } = await runCommand(["memory", "v2", "reembed"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("memory_v2_backfill");
    expect(lastIpcCall!.params.body).toEqual({ op: "reembed" });
  });

  test("logs the returned jobId", async () => {
    mockIpcResult = { ok: true, result: { jobId: "reembed-abc" } };

    await runCommand(["memory", "v2", "reembed"]);

    expect(logOutput.some((line) => line.includes("reembed-abc"))).toBe(true);
  });

  test("exits with code 1 on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Job queue full" };

    const { exitCode } = await runCommand(["memory", "v2", "reembed"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// reembed-skills
// ---------------------------------------------------------------------------

describe("memory v2 reembed-skills", () => {
  test("sends memory_v2/reembed_skills with no body params", async () => {
    mockIpcResult = { ok: true, result: { reembedded: 12 } };

    const { exitCode } = await runCommand(["memory", "v2", "reembed-skills"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("memory_v2_reembed_skills");
    expect(lastIpcCall!.params.body).toEqual({});
  });

  test("logs completion message on success", async () => {
    mockIpcResult = { ok: true, result: { reembedded: 7 } };

    await runCommand(["memory", "v2", "reembed-skills"]);

    expect(logOutput.some((line) => line.includes("complete"))).toBe(true);
  });

  test("exits with code 1 on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Memory v2 not enabled" };

    const { exitCode } = await runCommand(["memory", "v2", "reembed-skills"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// activation
// ---------------------------------------------------------------------------

describe("memory v2 activation", () => {
  test("sends memory_v2/backfill with op=activation-recompute", async () => {
    mockIpcResult = { ok: true, result: { jobId: "activation-1" } };

    const { exitCode } = await runCommand(["memory", "v2", "activation"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("memory_v2_backfill");
    expect(lastIpcCall!.params.body).toEqual({ op: "activation-recompute" });
  });

  test("logs the returned jobId", async () => {
    mockIpcResult = { ok: true, result: { jobId: "activation-abc" } };

    await runCommand(["memory", "v2", "activation"]);

    expect(logOutput.some((line) => line.includes("activation-abc"))).toBe(
      true,
    );
  });

  test("exits with code 1 on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Connection timeout" };

    const { exitCode } = await runCommand(["memory", "v2", "activation"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe("memory v2 validate", () => {
  test("sends memory_v2/validate with no params", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        pageCount: 0,
        edgeCount: 0,
        missingEdgeEndpoints: [],
        oversizedPages: [],
        parseFailures: [],
      },
    };

    const { exitCode } = await runCommand(["memory", "v2", "validate"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("memory_v2_validate");
    expect(lastIpcCall!.params.body).toEqual({});
  });

  test("prints zero-violation report cleanly", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        pageCount: 49,
        edgeCount: 166,
        missingEdgeEndpoints: [],
        oversizedPages: [],
        parseFailures: [],
      },
    };

    const { exitCode } = await runCommand(["memory", "v2", "validate"]);

    expect(exitCode).toBe(0);
    expect(logOutput.some((line) => line.includes("Pages: 49"))).toBe(true);
    expect(logOutput.some((line) => line.includes("Edges: 166"))).toBe(true);
    expect(
      logOutput.some((line) => line.includes("Missing edge endpoints: none")),
    ).toBe(true);
    expect(
      logOutput.some((line) => line.includes("Oversized pages: none")),
    ).toBe(true);
    expect(
      logOutput.some((line) => line.includes("Parse failures: none")),
    ).toBe(true);
  });

  test("exits non-zero and prints violation lists when present", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        pageCount: 10,
        edgeCount: 20,
        missingEdgeEndpoints: [{ from: "people/alice", to: "people/missing" }],
        oversizedPages: [{ slug: "arcs/big-day", chars: 12345 }],
        parseFailures: [
          { slug: "people/broken", error: "missing frontmatter" },
        ],
      },
    };

    const { exitCode } = await runCommand(["memory", "v2", "validate"]);

    expect(exitCode).toBe(1);
    expect(logOutput.some((line) => line.includes("people/missing"))).toBe(
      true,
    );
    expect(logOutput.some((line) => line.includes("arcs/big-day"))).toBe(true);
    expect(logOutput.some((line) => line.includes("people/broken"))).toBe(true);
  });

  test("exits with code 1 on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Daemon down" };

    const { exitCode } = await runCommand(["memory", "v2", "validate"]);

    expect(exitCode).toBe(1);
  });
});
