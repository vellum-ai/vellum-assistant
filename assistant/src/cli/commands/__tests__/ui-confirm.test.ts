/**
 * Tests for the `assistant ui confirm` CLI command.
 *
 * Validates:
 *   - Confirmation surface shape (actions, surfaceType)
 *   - Exit code: 0 on confirm, 1 on deny/cancel/timeout
 *   - --title, --message, --confirm-label, --deny-label mapping
 *   - --json output contract: { ok, confirmed, status, actionId, surfaceId }
 *   - Conversation ID resolution (same as ui request)
 *   - IPC error handling
 */

import { existsSync as actualExistsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: {
  method: string;
  params?: Record<string, unknown>;
  options?: { timeoutMs?: number };
} | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = {
  ok: true,
  result: {
    status: "submitted",
    actionId: "confirm",
    surfaceId: "test-surface-1",
  },
};

/** Saved env for restoration. */
let savedEnv: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => {
    lastIpcCall = { method, params, options };
    return mockIpcResult;
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

mock.module("node:fs", () => ({
  readFileSync: () => {
    throw new Error("ui confirm should not read stdin");
  },
  existsSync: actualExistsSync,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerUiCommand } = await import("../ui.js");

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
    registerUiCommand(program);
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
  mockIpcResult = {
    ok: true,
    result: {
      status: "submitted",
      actionId: "confirm",
      surfaceId: "test-surface-1",
    },
  };
  process.exitCode = 0;

  savedEnv = {
    __SKILL_CONTEXT_JSON: process.env.__SKILL_CONTEXT_JSON,
  };
  // Set a default skill context so tests don't need to repeat it
  process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
    conversationId: "conv-default",
  });
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// Confirmation surface shape
// ---------------------------------------------------------------------------

describe("ui confirm — surface shape", () => {
  test("sends confirmation surfaceType with confirm/deny actions", async () => {
    await runCommand(["ui", "confirm", "--message", "Delete?"]);

    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("ui_request");
    expect(lastIpcCall!.params!.surfaceType).toBe("confirmation");
    expect(lastIpcCall!.params!.actions).toEqual([
      { id: "confirm", label: "Confirm", variant: "primary" },
      { id: "deny", label: "Deny", variant: "secondary" },
    ]);
  });

  test("maps --message to data.message", async () => {
    await runCommand(["ui", "confirm", "--message", "Are you sure?"]);

    expect(lastIpcCall!.params!.data).toEqual({
      message: "Are you sure?",
      confirmLabel: "Confirm",
      cancelLabel: "Deny",
    });
  });

  test("maps --title to IPC title param", async () => {
    await runCommand([
      "ui",
      "confirm",
      "--title",
      "Danger",
      "--message",
      "Really?",
    ]);

    expect(lastIpcCall!.params!.title).toBe("Danger");
  });

  test("uses custom --confirm-label and --deny-label in actions", async () => {
    await runCommand([
      "ui",
      "confirm",
      "--message",
      "Continue?",
      "--confirm-label",
      "Yes",
      "--deny-label",
      "No",
    ]);

    expect(lastIpcCall!.params!.actions).toEqual([
      { id: "confirm", label: "Yes", variant: "primary" },
      { id: "deny", label: "No", variant: "secondary" },
    ]);
  });

  test("passes custom labels in data.confirmLabel and data.cancelLabel", async () => {
    await runCommand([
      "ui",
      "confirm",
      "--message",
      "Continue?",
      "--confirm-label",
      "Yes",
      "--deny-label",
      "No",
    ]);

    const data = lastIpcCall!.params!.data as Record<string, unknown>;
    expect(data.confirmLabel).toBe("Yes");
    expect(data.cancelLabel).toBe("No");
  });

  test("passes default labels in data.confirmLabel and data.cancelLabel", async () => {
    await runCommand(["ui", "confirm", "--message", "OK?"]);

    const data = lastIpcCall!.params!.data as Record<string, unknown>;
    expect(data.confirmLabel).toBe("Confirm");
    expect(data.cancelLabel).toBe("Deny");
  });

  test("includes confirmLabel and cancelLabel in data even when --message is omitted", async () => {
    await runCommand(["ui", "confirm"]);

    const data = lastIpcCall!.params!.data as Record<string, unknown>;
    expect(data.confirmLabel).toBe("Confirm");
    expect(data.cancelLabel).toBe("Deny");
  });
});

// ---------------------------------------------------------------------------
// Exit code behavior
// ---------------------------------------------------------------------------

describe("ui confirm — exit codes", () => {
  test("exits 0 when user confirms", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        status: "submitted",
        actionId: "confirm",
        surfaceId: "s-1",
      },
    };

    const { exitCode } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
    ]);

    expect(exitCode).toBe(0);
  });

  test("exits 1 when user denies", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        status: "submitted",
        actionId: "deny",
        surfaceId: "s-2",
      },
    };

    const { exitCode } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
    ]);

    expect(exitCode).toBe(1);
  });

  test("exits 1 when request is cancelled", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        status: "cancelled",
        surfaceId: "s-3",
      },
    };

    const { exitCode } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
    ]);

    expect(exitCode).toBe(1);
  });

  test("exits 1 when request times out", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        status: "timed_out",
        surfaceId: "s-4",
      },
    };

    const { exitCode } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
    ]);

    expect(exitCode).toBe(1);
  });

  test("exits 1 on IPC error", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

describe("ui confirm — JSON output", () => {
  test("outputs { ok: true, confirmed: true } on confirm", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        status: "submitted",
        actionId: "confirm",
        surfaceId: "s-1",
      },
    };

    const { exitCode, stdout } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      ok: true,
      confirmed: true,
      status: "submitted",
      actionId: "confirm",
      surfaceId: "s-1",
    });
  });

  test("outputs { ok: true, confirmed: false } on deny", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        status: "submitted",
        actionId: "deny",
        surfaceId: "s-2",
      },
    };

    const { exitCode, stdout } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.confirmed).toBe(false);
    expect(parsed.status).toBe("submitted");
    expect(parsed.actionId).toBe("deny");
  });

  test("outputs { ok: true, confirmed: false } on timeout", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        status: "timed_out",
        surfaceId: "s-3",
      },
    };

    const { stdout } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--json",
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.confirmed).toBe(false);
    expect(parsed.status).toBe("timed_out");
  });

  test("outputs { ok: false, error } on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Daemon not running" };

    const { exitCode, stdout } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: false, error: "Daemon not running" });
  });

  test("includes decisionToken in JSON output when present", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        status: "submitted",
        actionId: "confirm",
        surfaceId: "s-token",
        decisionToken: "eyJ0ZXN0IjoidG9rZW4ifQ.abc123",
      },
    };

    const { exitCode, stdout } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.decisionToken).toBe("eyJ0ZXN0IjoidG9rZW4ifQ.abc123");
  });

  test("includes summary in JSON output when present", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        status: "submitted",
        actionId: "confirm",
        surfaceId: "s-summary",
        summary: "User confirmed deployment",
      },
    };

    const { exitCode, stdout } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.summary).toBe("User confirmed deployment");
  });

  test("omits decisionToken and summary from JSON when absent", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        status: "submitted",
        actionId: "confirm",
        surfaceId: "s-no-extras",
      },
    };

    const { stdout } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--json",
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed.decisionToken).toBeUndefined();
    expect(parsed.summary).toBeUndefined();
    expect("decisionToken" in parsed).toBe(false);
    expect("summary" in parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conversation ID resolution
// ---------------------------------------------------------------------------

describe("ui confirm — conversation ID", () => {
  test("uses explicit --conversation-id", async () => {
    await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--conversation-id",
      "explicit-conv",
    ]);

    expect(lastIpcCall!.params!.conversationId).toBe("explicit-conv");
  });

  test("falls back to __SKILL_CONTEXT_JSON", async () => {
    await runCommand(["ui", "confirm", "--message", "OK?"]);

    expect(lastIpcCall!.params!.conversationId).toBe("conv-default");
  });

  test("errors when no conversation ID is available", async () => {
    delete process.env.__SKILL_CONTEXT_JSON;

    const { exitCode, stdout } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No conversation ID");
  });
});

// ---------------------------------------------------------------------------
// Timeout configuration
// ---------------------------------------------------------------------------

describe("ui confirm — timeout", () => {
  test("passes --timeout to IPC params", async () => {
    await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--timeout",
      "30000",
    ]);

    expect(lastIpcCall!.params!.timeoutMs).toBe(30_000);
    expect(lastIpcCall!.options!.timeoutMs).toBe(40_000); // +10s buffer
  });

  test("uses default timeout when --timeout is omitted", async () => {
    await runCommand(["ui", "confirm", "--message", "OK?"]);

    expect(lastIpcCall!.params!.timeoutMs).toBe(300_000);
    expect(lastIpcCall!.options!.timeoutMs).toBe(310_000);
  });

  test("rejects --timeout with trailing non-digit characters like '30s'", async () => {
    const { exitCode, stdout } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--timeout",
      "30s",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid --timeout");
  });

  test("rejects --timeout with scientific notation like '1e3'", async () => {
    const { exitCode, stdout } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--timeout",
      "1e3",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid --timeout");
  });
});

// ---------------------------------------------------------------------------
// Conversation ID discovery hint
// ---------------------------------------------------------------------------

describe("ui confirm — conversation ID discovery hint", () => {
  test("error message mentions 'assistant conversations list'", async () => {
    delete process.env.__SKILL_CONTEXT_JSON;

    const { exitCode, stdout } = await runCommand([
      "ui",
      "confirm",
      "--message",
      "OK?",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toContain("assistant conversations list");
  });
});
