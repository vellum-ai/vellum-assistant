/**
 * CLI plumbing tests for `assistant inference send` and the `llm send` alias.
 *
 * The actual `sendMessage` call runs inside the daemon; the CLI shells out
 * via `cliIpcCall(...)`. Tests here cover pure CLI surface concerns: help
 * rendering, argument validation, and the no-message guard. They run
 * entirely inside the CLI process and need no daemon stub.
 *
 * The IPC client is mocked with canned responses so tests can assert the
 * request contract without opening an assistant socket.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockStdinContent: string | null = null;
let lastIpcCall: {
  method: string;
  params?: Record<string, unknown>;
  options?: { timeoutMs?: number };
} | null = null;
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = {
  ok: true,
  result: {
    response: "Hello from the model.",
    model: "test-model",
    usage: { inputTokens: 3, outputTokens: 4 },
  },
};

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

mock.module("../../../providers/provider-send-message.js", () => ({
  // The handler under test calls getConfiguredProvider before any of the
  // validation paths exercised here are reached. Return a stub so module
  // loads cleanly even though no test actually drives a request.
  getConfiguredProvider: async () => null,
  extractAllText: () => "",
  userMessage: (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
  }),
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

// Stdin is read via fd 0 through the shared helper, never by reopening
// "/dev/stdin" (which fails ENXIO for pipe read-ends). A null content
// simulates stdin with no readable data.
mock.module("../../../util/read-stdin.js", () => ({
  STDIN_FD: 0,
  readStdinSync: () => {
    if (mockStdinContent === null) {
      throw new Error("EAGAIN: resource temporarily unavailable");
    }
    return mockStdinContent;
  },
}));

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

beforeEach(() => {
  mockStdinContent = null;
  lastIpcCall = null;
  mockIpcResult = {
    ok: true,
    result: {
      response: "Hello from the model.",
      model: "test-model",
      usage: { inputTokens: 3, outputTokens: 4 },
    },
  };
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

describe("help text", () => {
  test("inference send --help renders argument docs", async () => {
    const { stdout } = await runCommand(["inference", "send", "--help"]);
    expect(stdout).toContain("send");
    expect(stdout).toContain("--system-prompt");
    expect(stdout).toContain("--model");
    expect(stdout).toContain("--profile");
    expect(stdout).toContain("--max-tokens");
    expect(stdout).toContain("--timeout-seconds");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("[message...]");
  });

  test("llm send --help renders argument docs", async () => {
    const { stdout } = await runCommand(["llm", "send", "--help"]);
    expect(stdout).toContain("send");
    expect(stdout).toContain("--system-prompt");
    expect(stdout).toContain("--model");
    expect(stdout).toContain("--profile");
    expect(stdout).toContain("--max-tokens");
    expect(stdout).toContain("--timeout-seconds");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("[message...]");
  });

  test("inference --help renders with examples", async () => {
    const { stdout } = await runCommand(["inference", "--help"]);
    expect(stdout).toContain("inference");
    expect(stdout).toContain("Examples:");
  });

  test("llm --help renders with examples", async () => {
    const { stdout } = await runCommand(["llm", "--help"]);
    expect(stdout).toContain("llm");
    expect(stdout).toContain("Examples:");
  });
});

// ---------------------------------------------------------------------------
// No message provided
// ---------------------------------------------------------------------------

describe("no message provided", () => {
  test("exits with code 1 when no args and no stdin", async () => {
    const { exitCode, stdout } = await runCommand([
      "inference",
      "send",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No message provided");
  });

  test("exits with code 1 when empty stdin", async () => {
    mockStdinContent = "   ";

    const { exitCode, stdout } = await runCommand([
      "inference",
      "send",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No message provided");
  });
});

// ---------------------------------------------------------------------------
// --max-tokens validation
// ---------------------------------------------------------------------------

describe("--max-tokens", () => {
  test("errors on invalid max-tokens value", async () => {
    const { exitCode, stdout } = await runCommand([
      "inference",
      "send",
      "--max-tokens",
      "abc",
      "--json",
      "Hello",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid --max-tokens");
  });
});

// ---------------------------------------------------------------------------
// IPC timeout
// ---------------------------------------------------------------------------

describe("--timeout-seconds", () => {
  test("uses a long default IPC timeout for inference calls", async () => {
    const { exitCode, stdout } = await runCommand([
      "inference",
      "send",
      "--json",
      "Hello",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
    expect(lastIpcCall!.method).toBe("inference_send");
    expect(lastIpcCall!.options!.timeoutMs).toBe(32 * 60 * 1000);
  });

  test("passes custom timeout to IPC call", async () => {
    const { exitCode } = await runCommand([
      "llm",
      "send",
      "--timeout-seconds",
      "300",
      "Hello",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("inference_send");
    expect(lastIpcCall!.options!.timeoutMs).toBe(300_000);
  });

  test("errors on invalid timeout value", async () => {
    const { exitCode, stdout } = await runCommand([
      "inference",
      "send",
      "--timeout-seconds",
      "0",
      "--json",
      "Hello",
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid --timeout-seconds");
  });
});
