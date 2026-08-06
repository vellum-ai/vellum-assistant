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
  test("renders parent, indented children, and plugin/workspace origin", async () => {
    mockResponse = {
      ok: true,
      result: {
        processes: [
          {
            name: "assistant",
            status: "running",
            origin: "workspace",
            children: [
              { name: "qdrant", status: "running", origin: "workspace" },
              {
                name: "memory-worker",
                status: "running",
                origin: "plugin:default-memory",
              },
            ],
          },
        ],
      },
    };

    await runPsCommand();
    const lines = logLines.filter((l) => l.trim().length > 0);

    // Column 1 keeps the hierarchy indentation; the origin column follows.
    const root = lines.find((l) => l.startsWith("assistant"))!;
    const qdrant = lines.find((l) => l.trimStart().startsWith("qdrant"))!;
    const worker = lines.find((l) =>
      l.trimStart().startsWith("memory-worker"),
    )!;

    expect(qdrant).toMatch(/^ {2}qdrant/);
    expect(root).toContain("workspace");
    expect(qdrant).toContain("workspace");
    // The plugin's name is shown alongside the plugin tag.
    expect(worker).toContain("plugin:default-memory");

    // The status label is gone — no [running] anywhere.
    expect(logLines.join("\n")).not.toContain("[running]");
  });

  test("aligns column 2 to the same start index across all rows", async () => {
    mockResponse = {
      ok: true,
      result: {
        processes: [
          {
            name: "assistant",
            status: "running",
            origin: "workspace",
            children: [
              {
                name: "qdrant",
                status: "running",
                origin: "workspace",
                children: [
                  {
                    name: "deeply-nested-child",
                    status: "running",
                    origin: "plugin:cognee",
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    await runPsCommand();
    const lines = logLines.filter((l) => l.trim().length > 0);

    // The origin word starts at the same column on every row regardless of
    // the depth-driven indentation in column 1.
    const originStarts = lines.map((l) =>
      l.indexOf("workspace") === -1
        ? l.indexOf("plugin")
        : l.indexOf("workspace"),
    );
    expect(new Set(originStarts).size).toBe(1);
  });

  test("shows the pid info column", async () => {
    mockResponse = {
      ok: true,
      result: {
        processes: [
          {
            name: "qdrant",
            status: "running",
            origin: "workspace",
            info: "pid 4242",
          },
        ],
      },
    };

    await runPsCommand();
    expect(logLines.join("\n")).toContain("pid 4242");
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
