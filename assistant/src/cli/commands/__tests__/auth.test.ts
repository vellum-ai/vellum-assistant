/**
 * Tests for the `assistant auth` CLI command.
 *
 * Validates:
 *   - Authenticated: IPC ok response shows "yes" for authenticated status
 *   - Unauthenticated: IPC ok response shows "no" for authenticated status
 *   - IPC error results in non-zero exit code
 *   - cliIpcCall is called with the correct operation ID ("auth_status")
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let ipcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];

let mockResponse: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = { ok: true, result: null };

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return mockResponse;
  },
  exitFromIpcResult: (r: { ok: false; error?: string; statusCode?: number }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = r.statusCode !== undefined && r.statusCode >= 400 ? 2 : 10;
    throw new Error(`exitFromIpcResult`);
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    info: (...args: unknown[]) => {
      process.stdout.write(args.map(String).join(" ") + "\n");
    },
    warn: () => {},
    error: (...args: unknown[]) => {
      process.stderr.write(args.map(String).join(" ") + "\n");
    },
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: (...args: unknown[]) => {
      process.stdout.write(args.map(String).join(" ") + "\n");
    },
    warn: () => {},
    error: (...args: unknown[]) => {
      process.stderr.write(args.map(String).join(" ") + "\n");
    },
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerAuthCommand } = await import("../auth.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runAuthCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

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
    registerAuthCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
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
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  ipcCalls = [];
  mockResponse = { ok: true, result: null };
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auth info — authenticated", () => {
  test('shows "yes" when authenticated is true', async () => {
    mockResponse = {
      ok: true,
      result: {
        platformUrl: "https://platform.vellum.ai",
        assistantId: "abc",
        organizationId: "org1",
        userId: "user1",
        authenticated: true,
      },
    };

    const { stdout } = await runAuthCommand(["auth", "info"]);

    expect(stdout).toContain("yes");
  });

  test("shows platform URL, assistant ID, org ID, user ID when authenticated", async () => {
    mockResponse = {
      ok: true,
      result: {
        platformUrl: "https://platform.vellum.ai",
        assistantId: "abc",
        organizationId: "org1",
        userId: "user1",
        authenticated: true,
      },
    };

    const { stdout } = await runAuthCommand(["auth", "info"]);

    expect(stdout).toContain("https://platform.vellum.ai");
    expect(stdout).toContain("abc");
    expect(stdout).toContain("org1");
    expect(stdout).toContain("user1");
  });
});

describe("auth info — unauthenticated", () => {
  test('shows "no" when authenticated is false', async () => {
    mockResponse = {
      ok: true,
      result: {
        platformUrl: null,
        assistantId: null,
        organizationId: null,
        userId: null,
        authenticated: false,
        message: "Platform URL not configured. Run assistant config set platform.baseUrl <url>",
      },
    };

    const { stdout } = await runAuthCommand(["auth", "info"]);

    expect(stdout).toContain("no");
  });

  test("shows unauthenticated message in output", async () => {
    mockResponse = {
      ok: true,
      result: {
        platformUrl: null,
        assistantId: null,
        organizationId: null,
        userId: null,
        authenticated: false,
        message: "Platform URL not configured. Run assistant config set platform.baseUrl <url>",
      },
    };

    const { stdout } = await runAuthCommand(["auth", "info"]);

    expect(stdout).toContain("Platform URL not configured");
  });
});

describe("auth info — IPC error", () => {
  test("exits non-zero on IPC error", async () => {
    mockResponse = { ok: false, error: "Could not connect to the assistant" };

    const { exitCode } = await runAuthCommand(["auth", "info"]);

    expect(exitCode).not.toBe(0);
  });
});

describe("auth info — IPC call signature", () => {
  test('calls cliIpcCall with "auth_status" and no params', async () => {
    mockResponse = {
      ok: true,
      result: {
        platformUrl: "https://platform.vellum.ai",
        assistantId: "abc",
        organizationId: "org1",
        userId: "user1",
        authenticated: true,
      },
    };

    await runAuthCommand(["auth", "info"]);

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0].method).toBe("auth_status");
    expect(ipcCalls[0].params).toBeUndefined();
  });
});
