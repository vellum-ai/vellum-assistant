/**
 * Tests for the `assistant inference send` and `assistant llm send` CLI
 * commands.
 *
 * Validates:
 *   - Help text renders for both `inference send` and `llm send`
 *   - Error when no LLM provider is configured
 *   - Error when no message is provided (no args, no stdin)
 *   - Success with mocked provider (response text on stdout)
 *   - `--system-prompt` is passed through to the provider call
 *   - `--json` output format
 *   - `--model` override is passed through
 *   - `llm send` produces the same result as `inference send`
 */

import {
  existsSync as actualExistsSync,
  readFileSync as actualReadFileSync,
} from "node:fs";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../../../providers/types.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** Whether `getConfiguredProvider` returns a mock provider or null. */
let mockProviderAvailable = true;

/** The response the mock provider will return. */
let mockProviderResponse: ProviderResponse = {
  content: [{ type: "text", text: "42" }],
  model: "claude-test-1",
  usage: { inputTokens: 10, outputTokens: 5 },
  stopReason: "end_turn",
};

/** Captures the last `sendMessage` call for assertions. */
let lastSendMessageCall: {
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
  options?: SendMessageOptions;
} | null = null;

/** Simulated stdin content for the next command run. */
let mockStdinContent: string | null = null;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockProvider: Provider = {
  name: "mock-provider",
  sendMessage: async (
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ) => {
    lastSendMessageCall = { messages, tools, systemPrompt, options };
    return mockProviderResponse;
  },
};

mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () =>
    mockProviderAvailable ? mockProvider : null,
  extractAllText: (response: ProviderResponse) => {
    return response.content
      .filter(
        (
          b,
        ): b is Extract<(typeof response.content)[number], { type: "text" }> =>
          b.type === "text",
      )
      .map((b) => b.text)
      .join(" ");
  },
  userMessage: (text: string): Message => ({
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockProviderAvailable = true;
  mockProviderResponse = {
    content: [{ type: "text", text: "42" }],
    model: "claude-test-1",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  };
  lastSendMessageCall = null;
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
    expect(stdout).toContain("--max-tokens");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("[message...]");
  });

  test("llm send --help renders argument docs", async () => {
    const { stdout } = await runCommand(["llm", "send", "--help"]);
    expect(stdout).toContain("send");
    expect(stdout).toContain("--system-prompt");
    expect(stdout).toContain("--model");
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
// Error: no provider configured
// ---------------------------------------------------------------------------

describe("no provider configured", () => {
  test("exits with code 1 and actionable error when no provider", async () => {
    mockProviderAvailable = false;

    const { exitCode, stdout } = await runCommand([
      "inference",
      "send",
      "Hello",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No LLM provider is configured");
    expect(parsed.error).toContain("assistant config set");
  });
});

// ---------------------------------------------------------------------------
// Error: no message provided
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
// Success: positional args
// ---------------------------------------------------------------------------

describe("success with positional args", () => {
  test("sends message and prints response text", async () => {
    const { exitCode, stdout } = await runCommand([
      "inference",
      "send",
      "What",
      "is",
      "2+2?",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("42");
    expect(lastSendMessageCall).toBeDefined();
    expect(lastSendMessageCall!.messages[0].content[0]).toEqual({
      type: "text",
      text: "What is 2+2?",
    });
  });
});

// ---------------------------------------------------------------------------
// Success: stdin
// ---------------------------------------------------------------------------

describe("success with stdin", () => {
  test("reads message from stdin when no positional args", async () => {
    mockStdinContent = "What is 2+2?";

    const { exitCode, stdout } = await runCommand(["inference", "send"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("42");
    expect(lastSendMessageCall).toBeDefined();
    expect(lastSendMessageCall!.messages[0].content[0]).toEqual({
      type: "text",
      text: "What is 2+2?",
    });
  });
});

// ---------------------------------------------------------------------------
// --system-prompt
// ---------------------------------------------------------------------------

describe("--system-prompt", () => {
  test("passes system prompt through to provider", async () => {
    await runCommand([
      "inference",
      "send",
      "--system-prompt",
      "You are a poet",
      "Write a haiku",
    ]);

    expect(lastSendMessageCall).toBeDefined();
    expect(lastSendMessageCall!.systemPrompt).toBe("You are a poet");
  });
});

// ---------------------------------------------------------------------------
// --json output
// ---------------------------------------------------------------------------

describe("--json output", () => {
  test("produces structured JSON with response, model, and usage", async () => {
    const { exitCode, stdout } = await runCommand([
      "inference",
      "send",
      "--json",
      "Hello",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.response).toBe("42");
    expect(parsed.model).toBe("claude-test-1");
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// --model override
// ---------------------------------------------------------------------------

describe("--model override", () => {
  test("passes model override through to provider config", async () => {
    await runCommand([
      "inference",
      "send",
      "--model",
      "claude-sonnet-4-20250514",
      "Hello",
    ]);

    expect(lastSendMessageCall).toBeDefined();
    expect(lastSendMessageCall!.options?.config?.model).toBe(
      "claude-sonnet-4-20250514",
    );
  });
});

// ---------------------------------------------------------------------------
// --max-tokens
// ---------------------------------------------------------------------------

describe("--max-tokens", () => {
  test("passes max tokens through to provider config", async () => {
    await runCommand(["inference", "send", "--max-tokens", "1024", "Hello"]);

    expect(lastSendMessageCall).toBeDefined();
    expect(lastSendMessageCall!.options?.config?.max_tokens).toBe(1024);
  });

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
// llm alias equivalence
// ---------------------------------------------------------------------------

describe("llm alias", () => {
  test("llm send produces the same result as inference send", async () => {
    const inferenceResult = await runCommand([
      "inference",
      "send",
      "--json",
      "Hello",
    ]);

    // Reset for the second call
    lastSendMessageCall = null;

    const llmResult = await runCommand(["llm", "send", "--json", "Hello"]);

    expect(inferenceResult.exitCode).toBe(0);
    expect(llmResult.exitCode).toBe(0);
    expect(inferenceResult.stdout).toBe(llmResult.stdout);
  });
});
