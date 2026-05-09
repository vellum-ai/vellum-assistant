/**
 * Tests for the `assistant memory v2` CLI subgroup.
 *
 * Validates:
 *   - Subcommand registration (migrate, rebuild-edges, reembed, activation,
 *     validate) under `memory v2`.
 *   - Each mutating subcommand maps to the right `memory_v2_backfill` op.
 *   - `migrate --force` propagates `force: true`; bare `migrate` omits it.
 *   - `validate` calls `memory_v2_validate` and pretty-prints the report.
 *   - IPC error paths return a non-zero exit code without throwing.
 *   - `registerMemoryV2Command` throws if the parent `memory` command is
 *     not registered first (the contract documented in program.ts).
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

mock.module("../../../ipc/cli-client.js", () => ({
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
mock.module("../../../util/logger.js", () => ({
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
 * Build a fresh program with a stub `memory` parent command attached so the
 * v2 registrar has a parent to hang itself off. We deliberately stub the
 * parent rather than calling `registerMemoryCommand` because registering
 * the real parent pulls in heavy dependencies (DB, embedding backend) that
 * the v2 subgroup does not use.
 */
function buildProgramWithStubParent(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  program.command("memory").description("Stub parent for tests");
  registerMemoryV2Command(program);
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
    const program = buildProgramWithStubParent();
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
    const program = buildProgramWithStubParent();
    const memory = program.commands.find((c) => c.name() === "memory");
    expect(memory).toBeDefined();
    const v2 = memory!.commands.find((c) => c.name() === "v2");
    expect(v2).toBeDefined();
    const subcommandNames = v2!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual([
      "activation",
      "explain",
      "fit-anisotropy",
      "migrate",
      "rebuild-corpus-stats",
      "reembed",
      "reembed-skills",
      "validate",
    ]);
  });

  test("throws when parent memory command is missing", () => {
    const program = new Command();
    expect(() => registerMemoryV2Command(program)).toThrow(
      /parent `memory` command not found/,
    );
  });

  test("--help lists every registered subcommand", () => {
    const program = buildProgramWithStubParent();
    const memory = program.commands.find((c) => c.name() === "memory")!;
    const v2 = memory.commands.find((c) => c.name() === "v2")!;
    const help = v2.helpInformation();
    // Commander renders each subcommand on its own line under "Commands:".
    expect(help).toContain("migrate");
    expect(help).toContain("reembed");
    expect(help).toContain("reembed-skills");
    expect(help).toContain("activation");
    expect(help).toContain("validate");
    expect(help).toContain("explain");
    // rebuild-edges was retired alongside the directed-edges work.
    expect(help).not.toContain("rebuild-edges");
  });
});

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

describe("memory v2 migrate", () => {
  test("sends memory_v2/backfill with op=migrate", async () => {
    mockIpcResult = { ok: true, result: { jobId: "migrate-1" } };

    const { exitCode } = await runCommand(["memory", "v2", "migrate"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("memory_v2_backfill");
    expect(lastIpcCall!.params.body).toEqual({ op: "migrate" });
  });

  test("--force propagates force:true", async () => {
    mockIpcResult = { ok: true, result: { jobId: "migrate-2" } };

    await runCommand(["memory", "v2", "migrate", "--force"]);

    expect(lastIpcCall!.params.body).toEqual({ op: "migrate", force: true });
  });

  test("logs the returned jobId", async () => {
    mockIpcResult = { ok: true, result: { jobId: "migrate-abc" } };

    await runCommand(["memory", "v2", "migrate"]);

    expect(logOutput.some((line) => line.includes("migrate-abc"))).toBe(true);
  });

  test("exits with code 1 on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand(["memory", "v2", "migrate"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// rebuild-edges (removed — directed edges live in page frontmatter, no rebuild
// step is needed). The CLI subcommand was retired alongside the job handler.
// ---------------------------------------------------------------------------

describe("memory v2 rebuild-edges", () => {
  test("subcommand is no longer registered", async () => {
    mockIpcResult = { ok: true, result: { jobId: "should-not-fire" } };

    const { exitCode } = await runCommand(["memory", "v2", "rebuild-edges"]);

    // commander emits a non-zero exit for unknown subcommands; we just need
    // to verify the IPC call never happened.
    expect(exitCode).not.toBe(0);
    expect(lastIpcCall).toBeNull();
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
    mockIpcResult = { ok: false, error: "Connection refused" };

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
        pageCount: 12,
        edgeCount: 30,
        missingEdgeEndpoints: [],
        oversizedPages: [],
        parseFailures: [],
      },
    };

    await runCommand(["memory", "v2", "validate"]);

    const joined = logOutput.join("\n");
    expect(joined).toContain("Pages: 12");
    expect(joined).toContain("Edges: 30");
    expect(joined).toContain("Missing outgoing edge targets: none");
    expect(joined).toContain("Oversized pages: none");
    expect(joined).toContain("Parse failures: none");
  });

  test("prints violation lists when present", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        pageCount: 5,
        edgeCount: 8,
        missingEdgeEndpoints: [{ from: "alice", to: "bob" }],
        oversizedPages: [{ slug: "long-page", chars: 7500 }],
        parseFailures: [{ slug: "broken", error: "YAML parse error" }],
      },
    };

    await runCommand(["memory", "v2", "validate"]);

    const joined = logOutput.join("\n");
    expect(joined).toContain("Missing outgoing edge targets: 1");
    expect(joined).toContain("alice");
    expect(joined).toContain("bob");
    expect(joined).toContain("Oversized pages: 1");
    expect(joined).toContain("long-page");
    expect(joined).toContain("Parse failures: 1");
    expect(joined).toContain("broken");
    expect(joined).toContain("YAML parse error");
  });

  test("exits with code 1 on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Daemon not running" };

    const { exitCode } = await runCommand(["memory", "v2", "validate"]);

    expect(exitCode).toBe(1);
  });
});
