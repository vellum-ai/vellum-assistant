/**
 * Tests for the `assistant status` CLI command.
 *
 * Validates:
 *   - Successful IPC response shows version, workspace, and runtime health
 *   - When IPC fails (daemon down), prints "Daemon: down" or "Daemon: running"
 *     and exits with code 0 (not 1)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let ipcCalls: Array<{ method: string }> = [];
let mockResponse: { ok: boolean; result?: unknown; error?: string } = {
  ok: false,
  error: "ENOENT",
};

let socketExists = false;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string) => {
    ipcCalls.push({ method });
    return mockResponse;
  },
}));

mock.module("../../../ipc/socket-path.js", () => ({
  getAssistantSocketPath: () => "/tmp/test-assistant.sock",
}));

mock.module("node:fs", () => ({
  existsSync: (_path: string) => socketExists,
}));

mock.module("../../../util/platform.js", () => ({
  getWorkspaceDirDisplay: () => "~/.vellum/workspace",
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

const { registerStatusCommand } = await import("../status.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runStatusCommand(): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let capturedExitCode = 0;
  let exitCalled = false;

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExit = process.exit.bind(process);

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  // Override process.exit to capture the code instead of terminating
  (process as { exit: (code?: number) => never }).exit = ((code?: number) => {
    capturedExitCode = code ?? 0;
    exitCalled = true;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerStatusCommand(program);
    await program.parseAsync(["node", "assistant", "status"]);
  } catch (err) {
    // Swallow process.exit() throws and commander exitOverride errors
    if (err instanceof Error && !err.message.startsWith("process.exit(")) {
      // Commander parse errors; ignore
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    (process as { exit: (code?: number) => never }).exit = originalExit;
  }

  const exitCode = exitCalled ? capturedExitCode : (process.exitCode ?? 0);
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  ipcCalls = [];
  socketExists = false;
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("status command — daemon down", () => {
  test("exits with code 0 (not 1) when IPC call fails", async () => {
    mockResponse = { ok: false, error: "ENOENT" };
    socketExists = false;

    const { exitCode } = await runStatusCommand();

    expect(exitCode).toBe(0);
  });

  test('prints "Daemon: down" when socket file does not exist', async () => {
    mockResponse = { ok: false, error: "ENOENT" };
    socketExists = false;

    const { stdout, stderr } = await runStatusCommand();
    const combined = stdout + stderr;

    expect(combined).toContain("Assistant: down");
  });

  test('prints "Daemon: running" when socket file exists but IPC fails', async () => {
    mockResponse = { ok: false, error: "Connection closed before response" };
    socketExists = true;

    const { stdout, stderr } = await runStatusCommand();
    const combined = stdout + stderr;

    expect(combined).toContain("Assistant: running");
  });

  test("does not print version or memory when daemon is down", async () => {
    mockResponse = { ok: false, error: "ENOENT" };
    socketExists = false;

    const { stdout, stderr } = await runStatusCommand();
    const combined = stdout + stderr;

    expect(combined).not.toContain("Version");
    expect(combined).not.toContain("Memory");
  });
});

describe("status command — daemon up", () => {
  test("shows version and memory when IPC succeeds", async () => {
    mockResponse = {
      ok: true,
      result: {
        version: "1.2.3",
        memory: { currentMb: 100, maxMb: 500 },
        disk: null,
      },
    };

    const { stdout, stderr } = await runStatusCommand();
    const combined = stdout + stderr;

    expect(combined).toContain("1.2.3");
    expect(combined).toContain("100");
    expect(combined).toContain("500");
  });
});
