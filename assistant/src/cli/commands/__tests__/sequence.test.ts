/**
 * Tests for the `assistant sequence` CLI command.
 *
 * Validates:
 *   - Each subcommand forwards the correct IPC operation ID and params
 *   - IPC error → process exits non-zero
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let lastIpcCall: {
  method: string;
  params?: Record<string, unknown>;
} | null = null;

let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: {} };

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitFromIpcResult: (r: { ok: false; error?: string }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = 1;
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

const { registerSequenceCommand } = await import("../sequence.js");

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
    registerSequenceCommand(program);
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
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: { sequences: [] } };
  process.exitCode = 0;
});

// ===========================================================================
// sequence list
// ===========================================================================

describe("sequence list", () => {
  test("calls sequence_list with no params when no --status", async () => {
    mockIpcResult = { ok: true, result: { sequences: [] } };

    const { exitCode } = await runCommand(["sequence", "list"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("sequence_list");
    expect(lastIpcCall!.params).toBeUndefined();
  });

  test("passes --status active as queryParams", async () => {
    mockIpcResult = { ok: true, result: { sequences: [] } };

    const { exitCode } = await runCommand(["sequence", "list", "--status", "active"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("sequence_list");
    expect((lastIpcCall!.params as any)?.queryParams?.status).toBe("active");
  });

  test("IPC error sets exitCode non-zero", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand(["sequence", "list"]);

    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// sequence get
// ===========================================================================

describe("sequence get", () => {
  test("calls sequence_get with queryParams.id", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        sequence: {
          id: "seq_abc",
          name: "Test",
          status: "active",
          channel: "email",
          exitOnReply: true,
          steps: [],
        },
        enrollments: [],
        activeEnrollments: 0,
      },
    };

    const { exitCode } = await runCommand(["sequence", "get", "seq_abc"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("sequence_get");
    expect((lastIpcCall!.params as any)?.queryParams?.id).toBe("seq_abc");
  });

  test("IPC error sets exitCode non-zero", async () => {
    mockIpcResult = { ok: false, error: "Sequence not found" };

    const { exitCode } = await runCommand(["sequence", "get", "seq_abc"]);

    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// sequence pause
// ===========================================================================

describe("sequence pause", () => {
  test("calls sequence_pause with body.id", async () => {
    mockIpcResult = {
      ok: true,
      result: { sequence: { name: "My Seq" } },
    };

    const { exitCode } = await runCommand(["sequence", "pause", "seq_abc"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("sequence_pause");
    expect((lastIpcCall!.params as any)?.body?.id).toBe("seq_abc");
  });

  test("IPC error sets exitCode non-zero", async () => {
    mockIpcResult = { ok: false, error: "Not found" };

    const { exitCode } = await runCommand(["sequence", "pause", "seq_abc"]);

    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// sequence resume
// ===========================================================================

describe("sequence resume", () => {
  test("calls sequence_resume with body.id", async () => {
    mockIpcResult = {
      ok: true,
      result: { sequence: { name: "My Seq" } },
    };

    const { exitCode } = await runCommand(["sequence", "resume", "seq_abc"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("sequence_resume");
    expect((lastIpcCall!.params as any)?.body?.id).toBe("seq_abc");
  });

  test("IPC error sets exitCode non-zero", async () => {
    mockIpcResult = { ok: false, error: "Not found" };

    const { exitCode } = await runCommand(["sequence", "resume", "seq_abc"]);

    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// sequence cancel-enrollment
// ===========================================================================

describe("sequence cancel-enrollment", () => {
  test("calls sequence_enrollment_cancel with body.enrollmentId", async () => {
    mockIpcResult = { ok: true, result: { ok: true } };

    const { exitCode } = await runCommand([
      "sequence",
      "cancel-enrollment",
      "enr_xyz",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("sequence_enrollment_cancel");
    expect((lastIpcCall!.params as any)?.body?.enrollmentId).toBe("enr_xyz");
  });

  test("IPC error sets exitCode non-zero", async () => {
    mockIpcResult = { ok: false, error: "Enrollment not found" };

    const { exitCode } = await runCommand([
      "sequence",
      "cancel-enrollment",
      "enr_xyz",
    ]);

    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// sequence stats
// ===========================================================================

describe("sequence stats", () => {
  test("calls sequence_stats with no params", async () => {
    mockIpcResult = {
      ok: true,
      result: { sequences: [] },
    };

    const { exitCode } = await runCommand(["sequence", "stats"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("sequence_stats");
  });

  test("IPC error sets exitCode non-zero", async () => {
    mockIpcResult = { ok: false, error: "Daemon error" };

    const { exitCode } = await runCommand(["sequence", "stats"]);

    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// sequence guardrails show
// ===========================================================================

describe("sequence guardrails show", () => {
  test("calls sequence_guardrails_get", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        dailySendCap: 50,
        perSequenceHourlyRate: 10,
        minimumStepDelaySec: 60,
        maxActiveEnrollments: 200,
        duplicateEnrollmentCheck: true,
        cooldownPeriodMs: 604800000,
      },
    };

    const { exitCode } = await runCommand(["sequence", "guardrails", "show"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("sequence_guardrails_get");
  });

  test("IPC error sets exitCode non-zero", async () => {
    mockIpcResult = { ok: false, error: "Daemon error" };

    const { exitCode } = await runCommand(["sequence", "guardrails", "show"]);

    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// sequence guardrails set
// ===========================================================================

describe("sequence guardrails set", () => {
  test("calls sequence_guardrails_set with body.key and body.value", async () => {
    mockIpcResult = {
      ok: true,
      result: { dailySendCap: 100 },
    };

    const { exitCode } = await runCommand([
      "sequence",
      "guardrails",
      "set",
      "dailySendCap",
      "100",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("sequence_guardrails_set");
    expect((lastIpcCall!.params as any)?.body?.key).toBe("dailySendCap");
    expect((lastIpcCall!.params as any)?.body?.value).toBe("100");
  });

  test("IPC error sets exitCode non-zero", async () => {
    mockIpcResult = { ok: false, error: "Invalid key" };

    const { exitCode } = await runCommand([
      "sequence",
      "guardrails",
      "set",
      "badKey",
      "123",
    ]);

    expect(exitCode).not.toBe(0);
  });
});
