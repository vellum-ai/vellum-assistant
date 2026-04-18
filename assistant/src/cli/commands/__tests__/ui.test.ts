/**
 * Tests for the `assistant ui request` CLI command.
 *
 * Validates:
 *   - Subcommand registration (request, confirm)
 *   - Payload parsing from --payload flag and stdin
 *   - Conversation ID resolution (explicit, __SKILL_CONTEXT_JSON, missing)
 *   - IPC param mapping (surfaceType, title, timeoutMs)
 *   - IPC timeout budget (request timeout + buffer)
 *   - JSON output shape for success and error
 *   - Exit code behavior on IPC errors
 */

import {
  existsSync as actualExistsSync,
  readFileSync as actualReadFileSync,
} from "node:fs";
import { beforeEach, describe, expect, mock, test } from "bun:test";

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

/** Simulated stdin content for the next command run. */
let mockStdinContent: string | null = null;

/** Whether to simulate stdin as a TTY (no piped input). */
let mockStdinIsTTY: boolean = false;

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
  readFileSync: (path: string, encoding?: BufferEncoding) => {
    if (path === "/dev/stdin") {
      if (mockStdinContent === null) {
        throw new Error("EAGAIN: resource temporarily unavailable");
      }
      return mockStdinContent;
    }
    return actualReadFileSync(path, encoding);
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const localStderrChunks: string[] = [];

  const originalIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    value: mockStdinIsTTY ? true : undefined,
    configurable: true,
  });

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    localStderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
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
    registerUiCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: localStderrChunks.join(""),
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
  mockStdinContent = null;
  mockStdinIsTTY = false;
  process.exitCode = 0;

  // Save and clear env
  savedEnv = {
    __SKILL_CONTEXT_JSON: process.env.__SKILL_CONTEXT_JSON,
  };
  delete process.env.__SKILL_CONTEXT_JSON;
});

// Restore env after each test
import { afterEach } from "bun:test";
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
// Subcommand registration
// ---------------------------------------------------------------------------

describe("subcommand registration", () => {
  test("registers request and confirm subcommands under ui", () => {
    const program = new Command();
    registerUiCommand(program);
    const ui = program.commands.find((c) => c.name() === "ui");
    expect(ui).toBeDefined();
    const subcommandNames = ui!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual(["confirm", "request"]);
  });
});

// ---------------------------------------------------------------------------
// ui request — payload parsing
// ---------------------------------------------------------------------------

describe("ui request — payload parsing", () => {
  test("parses --payload flag and sends ui_request IPC", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-123",
    });

    const { exitCode } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"message":"Proceed?"}',
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("ui_request");
    expect(lastIpcCall!.params!.data).toEqual({ message: "Proceed?" });
  });

  test("parses JSON from stdin when no --payload flag", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-123",
    });
    mockStdinContent = '{"message":"From stdin"}';

    const { exitCode } = await runCommand(["ui", "request"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.data).toEqual({ message: "From stdin" });
  });

  test("errors on invalid JSON in --payload", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-123",
    });

    const { exitCode } = await runCommand([
      "ui",
      "request",
      "--payload",
      "{bad json}",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(
      (await runCommand(["ui", "request", "--payload", "{bad}", "--json"]))
        .stdout,
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid JSON");
  });

  test("errors on non-object --payload (array)", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-123",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      "[1,2,3]",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("JSON object");
  });

  test("errors on TTY stdin with no --payload", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-123",
    });
    mockStdinIsTTY = true;

    const { exitCode } = await runCommand(["ui", "request"]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("errors on empty stdin", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-123",
    });
    mockStdinContent = "   ";

    const { exitCode } = await runCommand(["ui", "request"]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ui request — conversation ID resolution
// ---------------------------------------------------------------------------

describe("ui request — conversation ID resolution", () => {
  test("uses explicit --conversation-id over env", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "from-env",
    });

    await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--conversation-id",
      "explicit-id",
    ]);

    expect(lastIpcCall!.params!.conversationId).toBe("explicit-id");
  });

  test("falls back to __SKILL_CONTEXT_JSON.conversationId", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "skill-conv-42",
    });

    await runCommand(["ui", "request", "--payload", '{"msg":"test"}']);

    expect(lastIpcCall!.params!.conversationId).toBe("skill-conv-42");
  });

  test("errors when no conversation ID is available", async () => {
    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No conversation ID");
  });

  test("errors when __SKILL_CONTEXT_JSON is invalid JSON", async () => {
    process.env.__SKILL_CONTEXT_JSON = "not-valid-json";

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No conversation ID");
  });

  test("errors when __SKILL_CONTEXT_JSON has no conversationId field", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({ workingDir: "/tmp" });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No conversation ID");
  });
});

// ---------------------------------------------------------------------------
// ui request — IPC param mapping
// ---------------------------------------------------------------------------

describe("ui request — IPC param mapping", () => {
  test("passes surfaceType from --surface-type flag", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    await runCommand([
      "ui",
      "request",
      "--payload",
      '{"fields":[]}',
      "--surface-type",
      "form",
    ]);

    expect(lastIpcCall!.params!.surfaceType).toBe("form");
  });

  test("defaults surfaceType to confirmation", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    await runCommand(["ui", "request", "--payload", '{"msg":"test"}']);

    expect(lastIpcCall!.params!.surfaceType).toBe("confirmation");
  });

  test("passes title from --title flag", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--title",
      "Important",
    ]);

    expect(lastIpcCall!.params!.title).toBe("Important");
  });

  test("does not include title when --title is omitted", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    await runCommand(["ui", "request", "--payload", '{"msg":"test"}']);

    expect(lastIpcCall!.params!.title).toBeUndefined();
  });

  test("passes timeoutMs from --timeout flag", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--timeout",
      "60000",
    ]);

    expect(lastIpcCall!.params!.timeoutMs).toBe(60_000);
  });

  test("uses default timeoutMs when --timeout is omitted", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    await runCommand(["ui", "request", "--payload", '{"msg":"test"}']);

    expect(lastIpcCall!.params!.timeoutMs).toBe(300_000);
  });

  test("IPC call timeout = request timeout + 10s buffer", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--timeout",
      "60000",
    ]);

    expect(lastIpcCall!.options!.timeoutMs).toBe(70_000);
  });

  test("errors on invalid --timeout value", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--timeout",
      "abc",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid --timeout");
  });

  test("rejects --timeout with trailing non-digit characters like '30s'", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
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
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--timeout",
      "1e3",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid --timeout");
  });

  test("rejects --timeout with decimal like '12.5'", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--timeout",
      "12.5",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid --timeout");
  });
});

// ---------------------------------------------------------------------------
// ui request — output
// ---------------------------------------------------------------------------

describe("ui request — output", () => {
  test("--json outputs full result on success", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });
    mockIpcResult = {
      ok: true,
      result: {
        status: "submitted",
        actionId: "confirm",
        surfaceId: "surface-abc",
      },
    };

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("submitted");
    expect(parsed.actionId).toBe("confirm");
    expect(parsed.surfaceId).toBe("surface-abc");
  });

  test("--json outputs error on IPC failure", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Connection refused");
  });

  test("exits 0 on successful IPC result", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });
    mockIpcResult = {
      ok: true,
      result: { status: "cancelled", surfaceId: "s-1" },
    };

    const { exitCode } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
    ]);

    // ui request exits 0 on any successful IPC result (even cancelled/timed_out),
    // because it reports the status — it's ui confirm that gates on actionId
    expect(exitCode).toBe(0);
  });

  test("exits 1 on IPC error", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });
    mockIpcResult = { ok: false, error: "timeout" };

    const { exitCode } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ui request — conversation ID discovery hint
// ---------------------------------------------------------------------------

describe("ui request — conversation ID discovery hint", () => {
  test("error message mentions 'assistant conversations list'", async () => {
    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toContain("assistant conversations list");
  });
});

// ---------------------------------------------------------------------------
// ui request — --actions parsing
// ---------------------------------------------------------------------------

describe("ui request — --actions parsing", () => {
  test("valid actions are parsed and included in IPC params", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const actions = [
      { id: "approve", label: "Approve", variant: "primary" },
      { id: "reject", label: "Reject", variant: "danger" },
    ];

    const { exitCode } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"Choose"}',
      "--actions",
      JSON.stringify(actions),
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.params!.actions).toEqual(actions);
  });

  test("actions without variant are accepted", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const actions = [{ id: "ok", label: "OK" }];

    const { exitCode } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      JSON.stringify(actions),
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.actions).toEqual([{ id: "ok", label: "OK" }]);
  });

  test("actions are omitted from IPC params when --actions is not provided", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.actions).toBeUndefined();
  });

  test("errors when --actions is an empty string", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      "",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid JSON in --actions");
  });

  test("errors on malformed JSON in --actions", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      "{not valid json",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid JSON in --actions");
  });

  test("errors when --actions is not an array", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      '{"id":"ok","label":"OK"}',
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("must be a JSON array");
  });

  test("errors when --actions is an empty array", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      "[]",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("at least one action");
  });

  test("errors when action is missing id", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      '[{"label":"OK"}]',
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('"id" is required');
  });

  test("errors when action id is empty string", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      '[{"id":"","label":"OK"}]',
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('"id" is required');
  });

  test("errors when action is missing label", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      '[{"id":"ok"}]',
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('"label" is required');
  });

  test("errors when action label is empty string", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      '[{"id":"ok","label":""}]',
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('"label" is required');
  });

  test("errors when action has invalid variant", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      '[{"id":"ok","label":"OK","variant":"invalid"}]',
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('"variant" must be one of');
  });

  test("errors when action item is not an object", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      '["not-an-object"]',
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("must be a JSON object");
  });

  test("accepts all valid variant values", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const actions = [
      { id: "a", label: "Primary", variant: "primary" },
      { id: "b", label: "Danger", variant: "danger" },
      { id: "c", label: "Secondary", variant: "secondary" },
    ];

    const { exitCode } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      JSON.stringify(actions),
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params!.actions).toEqual(actions);
  });

  test("action error references the correct array index", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    // Second action is invalid (index 1)
    const actions = [
      { id: "ok", label: "OK" },
      { id: "bad", label: "" },
    ];

    const { exitCode, stdout } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      JSON.stringify(actions),
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("--actions[1]");
  });

  test("action errors output as text when --json is not set", async () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-1",
    });

    const { exitCode } = await runCommand([
      "ui",
      "request",
      "--payload",
      '{"msg":"test"}',
      "--actions",
      "{bad",
    ]);

    expect(exitCode).toBe(1);
    // When --json is not set, errors go to log.error (mocked as no-op),
    // so stdout should be empty and IPC should not have been called
    expect(lastIpcCall).toBeNull();
  });
});
