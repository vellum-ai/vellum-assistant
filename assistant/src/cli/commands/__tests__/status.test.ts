/**
 * Tests for the `assistant status` CLI command.
 *
 * Validates:
 *   - Successful IPC response shows version, workspace, and runtime health
 *   - Daemon-unreachable (ENOENT/ECONNREFUSED) exits 0 with "Assistant: down/running"
 *   - Non-connection IPC failures (daemon-side error, framing) exit non-zero
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

// The exact prefix that cliIpcCall uses for ENOENT/ECONNREFUSED/connect-timeout.
const DAEMON_UNREACHABLE_ERROR =
  "Could not connect to the assistant at /tmp/test-assistant.sock.\n" +
  "Run `assistant status` to check, or `assistant gateway start` to start it.";

let ipcCalls: Array<{ method: string }> = [];
let mockResponse: { ok: boolean; result?: unknown; error?: string; statusCode?: number } = {
  ok: false,
  error: DAEMON_UNREACHABLE_ERROR,
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

// Fixed installed CLI version so drift-vs-match is deterministic.
const INSTALLED_CLI_VERSION = "9.9.9";
mock.module("../../../version.js", () => ({
  APP_VERSION: INSTALLED_CLI_VERSION,
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
  mockResponse = { ok: false, error: DAEMON_UNREACHABLE_ERROR };
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("status command — daemon unreachable (ENOENT/ECONNREFUSED)", () => {
  test("exits 0 when daemon is unreachable", async () => {
    mockResponse = { ok: false, error: DAEMON_UNREACHABLE_ERROR };
    socketExists = false;

    const { exitCode } = await runStatusCommand();

    expect(exitCode).toBe(0);
  });

  test('prints "Assistant: down" when socket file does not exist', async () => {
    mockResponse = { ok: false, error: DAEMON_UNREACHABLE_ERROR };
    socketExists = false;

    const { stdout } = await runStatusCommand();

    expect(stdout).toContain("Assistant: down");
  });

  test('prints "Assistant: running" when socket file exists but connection refused', async () => {
    mockResponse = { ok: false, error: DAEMON_UNREACHABLE_ERROR };
    socketExists = true;

    const { stdout } = await runStatusCommand();

    expect(stdout).toContain("Assistant: running");
  });

  test("prints the installed CLI version but no runtime health when unreachable", async () => {
    mockResponse = { ok: false, error: DAEMON_UNREACHABLE_ERROR };
    socketExists = false;

    const { stdout, stderr } = await runStatusCommand();

    expect(stdout).toContain(`CLI Version: ${INSTALLED_CLI_VERSION}`);
    expect(stdout + stderr).not.toContain("Memory");
  });
});

describe("status command — non-connection IPC failures", () => {
  test("exits non-zero when daemon returns an internal error", async () => {
    mockResponse = { ok: false, error: "Internal server error", statusCode: 500 };

    const { exitCode } = await runStatusCommand();

    expect(exitCode).toBe(1);
  });

  test("exits non-zero when connection closes before response", async () => {
    mockResponse = { ok: false, error: "Connection closed before response" };

    const { exitCode } = await runStatusCommand();

    expect(exitCode).toBe(1);
  });

  test("prints the error message to stderr for non-connection failures", async () => {
    mockResponse = { ok: false, error: "Internal server error", statusCode: 500 };

    const { stderr } = await runStatusCommand();

    expect(stderr).toContain("Internal server error");
  });

  test("exits non-zero and prints message for empty health response", async () => {
    mockResponse = { ok: true, result: undefined };

    const { exitCode, stderr } = await runStatusCommand();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("empty response");
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

    expect(combined).toContain("Assistant Version");
    expect(combined).toContain("1.2.3");
    expect(combined).toContain("100");
    expect(combined).toContain("500");
  });

  test("flags the runtime as stale when it differs from the installed CLI", async () => {
    mockResponse = {
      ok: true,
      result: {
        version: "1.2.3",
        memory: { currentMb: 100, maxMb: 500 },
        disk: null,
      },
    };

    const { stdout } = await runStatusCommand();

    expect(stdout).toContain(
      `1.2.3 (stale — restart to run ${INSTALLED_CLI_VERSION})`,
    );
  });

  test("shows a bare version with no stale note when versions match", async () => {
    mockResponse = {
      ok: true,
      result: {
        version: INSTALLED_CLI_VERSION,
        memory: { currentMb: 100, maxMb: 500 },
        disk: null,
      },
    };

    const { stdout } = await runStatusCommand();

    expect(stdout).toContain(`Assistant Version  ${INSTALLED_CLI_VERSION}`);
    expect(stdout).not.toContain("stale");
  });
});
