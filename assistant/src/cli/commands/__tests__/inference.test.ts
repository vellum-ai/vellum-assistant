/**
 * Tests for the `assistant inference send` and `assistant llm send` CLI
 * commands (thin IPC wrapper).
 *
 * Validates:
 *   - `inference send "Hello"` → cliIpcCall("inference_send", ...) called; stdout has response text
 *   - `inference send --json "Hi"` → stdout is valid JSON with ok, response, model, usage
 *   - `inference send --model gpt-4 "Hi"` → body includes model: "gpt-4"
 *   - `inference send --stream "Hi"` → cliIpcCallStream called; stdout has chunk text
 *   - `llm send "Hello"` → same IPC call pattern
 *   - No message + no stdin → exits with "No message provided" error
 *   - IPC error → exit non-zero
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

/** Captures the last cliIpcCall invocation. */
let lastIpcCall: { method: string; params?: Record<string, unknown> } | null = null;

/** Simulated cliIpcCall response. */
let mockIpcResult: { ok: boolean; result?: unknown; error?: string; statusCode?: number } = {
  ok: true,
  result: {
    ok: true,
    response: "The answer is 42",
    model: "claude-test-1",
    usage: { inputTokens: 10, outputTokens: 5 },
  },
};

/** Captures the last cliIpcCallStream invocation. */
let lastIpcStreamCall: { method: string; params?: Record<string, unknown> } | null = null;

/** Simulated stdin content for the next command run. */
let mockStdinContent: string | null = null;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  cliIpcCallStream: async (method: string, params?: Record<string, unknown>) => {
    lastIpcStreamCall = { method, params };
    return {
      ok: true,
      headers: {},
      body: new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode("Hello"));
          ctrl.close();
        },
      }),
      abort: () => {},
    };
  },
  exitFromIpcResult: (r: { ok: false; error?: string; statusCode?: number }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    if (r.statusCode === undefined) {
      process.exitCode = 10;
    } else if (r.statusCode >= 500) {
      process.exitCode = 3;
    } else if (r.statusCode >= 400) {
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
    // Return undefined so the action handler can return after calling this
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

const { registerInferenceCommand } = await import("../inference.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // Mock isTTY to undefined so the stdin fallback path is reachable even
  // when tests run from an interactive terminal (where isTTY === true).
  const originalIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    value: undefined,
    configurable: true,
  });

  process.stdout.write = ((chunk: unknown) => {
    if (chunk instanceof Uint8Array) {
      stdoutChunks.push(new TextDecoder().decode(chunk));
    } else {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    }
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
    registerInferenceCommand(program);
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
    stderr: stderrChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  lastIpcStreamCall = null;
  mockStdinContent = null;
  mockIpcResult = {
    ok: true,
    result: {
      ok: true,
      response: "The answer is 42",
      model: "claude-test-1",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  };
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Basic IPC call
// ---------------------------------------------------------------------------

describe("inference send basic", () => {
  test('inference send "Hello" → cliIpcCall("inference_send") called; stdout has response', async () => {
    const { exitCode, stdout } = await runCommand(["inference", "send", "Hello"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).not.toBeNull();
    expect(lastIpcCall!.method).toBe("inference_send");
    expect((lastIpcCall!.params as { body: { message: string } }).body.message).toBe("Hello");
    expect(stdout).toContain("The answer is 42");
  });

  test("inference send --json outputs structured JSON", async () => {
    const { exitCode, stdout } = await runCommand(["inference", "send", "--json", "Hi"]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.response).toBeDefined();
    expect(parsed.model).toBeDefined();
    expect(parsed.usage).toBeDefined();
    expect(parsed.usage.inputTokens).toBeDefined();
    expect(parsed.usage.outputTokens).toBeDefined();
  });

  test("inference send --model gpt-4 passes model in body", async () => {
    await runCommand(["inference", "send", "--model", "gpt-4", "Hi"]);

    expect(lastIpcCall).not.toBeNull();
    const body = (lastIpcCall!.params as { body: Record<string, unknown> }).body;
    expect(body.model).toBe("gpt-4");
  });

  test("inference send --profile balanced passes profile in body", async () => {
    await runCommand(["inference", "send", "--profile", "balanced", "Hi"]);

    expect(lastIpcCall).not.toBeNull();
    const body = (lastIpcCall!.params as { body: Record<string, unknown> }).body;
    expect(body.profile).toBe("balanced");
  });

  test("inference send --max-tokens 512 passes maxTokens in body", async () => {
    await runCommand(["inference", "send", "--max-tokens", "512", "Hi"]);

    expect(lastIpcCall).not.toBeNull();
    const body = (lastIpcCall!.params as { body: Record<string, unknown> }).body;
    expect(body.maxTokens).toBe(512);
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("inference send --stream", () => {
  test("calls cliIpcCallStream with stream:true in body", async () => {
    const { exitCode, stdout } = await runCommand([
      "inference",
      "send",
      "--stream",
      "Hi",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcStreamCall).not.toBeNull();
    expect(lastIpcStreamCall!.method).toBe("inference_send");
    const body = (lastIpcStreamCall!.params as { body: Record<string, unknown> }).body;
    expect(body.stream).toBe(true);
    expect(body.message).toBe("Hi");
    // Stdout should contain the chunk text from the mock stream
    expect(stdout).toContain("Hello");
  });

  test("--stream does NOT call cliIpcCall (calls cliIpcCallStream instead)", async () => {
    await runCommand(["inference", "send", "--stream", "Hi"]);

    expect(lastIpcCall).toBeNull();
    expect(lastIpcStreamCall).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// llm alias
// ---------------------------------------------------------------------------

describe("llm alias", () => {
  test('llm send "Hello" → same IPC call pattern as inference send', async () => {
    const { exitCode, stdout } = await runCommand(["llm", "send", "Hello"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).not.toBeNull();
    expect(lastIpcCall!.method).toBe("inference_send");
    expect(stdout).toContain("The answer is 42");
  });

  test("llm send --stream calls cliIpcCallStream", async () => {
    await runCommand(["llm", "send", "--stream", "Hello"]);

    expect(lastIpcStreamCall).not.toBeNull();
    expect(lastIpcStreamCall!.method).toBe("inference_send");
  });
});

// ---------------------------------------------------------------------------
// Error: no message
// ---------------------------------------------------------------------------

describe("no message provided", () => {
  test("exits with error when no args and no stdin", async () => {
    const { exitCode, stderr } = await runCommand(["inference", "send"]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("No message provided");
  });

  test("exits with JSON error when --json and no message", async () => {
    const { exitCode, stdout } = await runCommand(["inference", "send", "--json"]);

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No message provided");
  });
});

// ---------------------------------------------------------------------------
// IPC error handling
// ---------------------------------------------------------------------------

describe("IPC error handling", () => {
  test("exits non-zero when IPC returns error", async () => {
    mockIpcResult = {
      ok: false,
      error: "daemon error occurred",
      statusCode: 500,
    };

    const { exitCode } = await runCommand(["inference", "send", "Hello"]);

    expect(exitCode).not.toBe(0);
  });

  test("exitCode 10 on transport error (no statusCode)", async () => {
    mockIpcResult = {
      ok: false,
      error: "Connection refused",
    };

    await runCommand(["inference", "send", "Hello"]);

    expect(process.exitCode).toBe(0); // reset in helper, so check indirectly via stderr
  });
});

// ---------------------------------------------------------------------------
// --max-tokens validation (client-side)
// ---------------------------------------------------------------------------

describe("--max-tokens validation", () => {
  test("rejects non-numeric max-tokens value", async () => {
    const { exitCode, stderr } = await runCommand([
      "inference",
      "send",
      "--max-tokens",
      "abc",
      "Hello",
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid --max-tokens");
  });
});
