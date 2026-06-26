/**
 * Tests for the `assistant ps` CLI command.
 *
 * Validates:
 *   - Calls the `ps` IPC method exactly once
 *   - Renders the daemon process tree (parent + indented children + status)
 *   - `--json` emits the raw route payload instead of the tree
 *   - IPC failures surface via exitFromIpcResult (non-zero exit)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let ipcCalls: Array<{ method: string }> = [];
let mockResponse: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = { ok: true, result: { processes: [] } };

let logLines: string[] = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string) => {
    ipcCalls.push({ method });
    return mockResponse;
  },
  exitFromIpcResult: (r: { error?: string }) => {
    process.stderr.write((r.error ?? "error") + "\n");
    process.exit(1);
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
    info: (msg: string) => logLines.push(msg),
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerPsCommand } = await import("../ps.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runPsCommand(
  args: string[] = [],
): Promise<{ stdout: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  let capturedExitCode = 0;
  let exitCalled = false;

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalExit = process.exit.bind(process);

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  (process as { exit: (code?: number) => never }).exit = ((code?: number) => {
    capturedExitCode = code ?? 0;
    exitCalled = true;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerPsCommand(program);
    await program.parseAsync(["node", "assistant", "ps", ...args]);
  } catch (err) {
    if (err instanceof Error && !err.message.startsWith("process.exit(")) {
      // Commander parse errors; ignore
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    (process as { exit: (code?: number) => never }).exit = originalExit;
  }

  const exitCode = exitCalled ? capturedExitCode : (process.exitCode ?? 0);
  process.exitCode = 0;

  return { exitCode, stdout: stdoutChunks.join("") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  ipcCalls = [];
  logLines = [];
  mockResponse = { ok: true, result: { processes: [] } };
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ps command — IPC wiring", () => {
  test("calls the `ps` IPC method exactly once", async () => {
    await runPsCommand();
    expect(ipcCalls).toEqual([{ method: "ps" }]);
  });
});

describe("ps command — tree rendering", () => {
  test("renders parent, indented children, and status labels", async () => {
    mockResponse = {
      ok: true,
      result: {
        processes: [
          {
            name: "assistant",
            status: "running",
            children: [
              { name: "qdrant", status: "running" },
              { name: "embed-worker", status: "not_running" },
            ],
          },
        ],
      },
    };

    await runPsCommand();
    const out = logLines.join("\n");

    expect(out).toContain("assistant  [running]");
    expect(out).toContain("  qdrant  [running]");
    expect(out).toContain("  embed-worker  [not running]");
  });

  test("appends info text when present", async () => {
    mockResponse = {
      ok: true,
      result: {
        processes: [
          { name: "qdrant", status: "unreachable", info: "probe timed out" },
        ],
      },
    };

    await runPsCommand();
    expect(logLines.join("\n")).toContain(
      "qdrant  [unreachable] — probe timed out",
    );
  });

  test("prints a placeholder when no processes are reported", async () => {
    mockResponse = { ok: true, result: { processes: [] } };
    await runPsCommand();
    expect(logLines.join("\n")).toContain("No processes reported.");
  });
});

describe("ps command — JSON output", () => {
  test("--json emits the raw route payload, not the tree", async () => {
    const result = {
      processes: [{ name: "assistant", status: "running" }],
    };
    mockResponse = { ok: true, result };

    const { stdout } = await runPsCommand(["--json"]);

    expect(JSON.parse(stdout)).toEqual(result);
    // Tree renderer should not have run.
    expect(logLines.join("\n")).not.toContain("[running]");
  });
});

describe("ps command — failures", () => {
  test("exits non-zero when the IPC call fails", async () => {
    mockResponse = { ok: false, error: "boom", statusCode: 500 };
    const { exitCode } = await runPsCommand();
    expect(exitCode).toBe(1);
  });
});
