/**
 * CLI plumbing tests for `assistant inference send` and the `llm send` alias.
 *
 * The actual `sendMessage` call runs inside the daemon; the CLI shells out
 * via `cliIpcCall(...)`. Tests here cover pure CLI surface concerns: help
 * rendering, argument validation, and the no-message guard. They run
 * entirely inside the CLI process and need no daemon stub.
 *
 * Follow-up opportunity: mock `../../../ipc/cli-client.js` with canned
 * responses to cover the deeper send-message paths against the IPC contract.
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

let mockStdinContent: string | null = null;

mock.module("../../../providers/provider-send-message.js", () => ({
  // The handler under test calls getConfiguredProvider before any of the
  // validation paths exercised here are reached. Return a stub so module
  // loads cleanly even though no test actually drives a request.
  getConfiguredProvider: async () => null,
  extractAllText: () => "",
  userMessage: (text: string) => ({ role: "user", content: [{ type: "text", text }] }),
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({ llm: { profiles: {} } }),
  getConfigReadOnly: () => ({ llm: { profiles: {} } }),
  loadConfig: () => ({ llm: { profiles: {} } }),
  loadRawConfig: () => ({}) as Record<string, unknown>,
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  applyNestedDefaults: () => ({ llm: { profiles: {} } }),
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getCliLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
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
