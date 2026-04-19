/**
 * Tests for the `assistant browser` CLI command.
 *
 * Validates:
 *   - Subcommand registration count and names
 *   - Required-argument enforcement (navigate, type, press-key, scroll, fill-credential)
 *   - Correct IPC payload mapping (kebab-case CLI -> snake_case input)
 *   - --json and error exit-code behavior
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import { BROWSER_OPERATION_META } from "../../../browser/operations.js";
import { BROWSER_OPERATIONS } from "../../../browser/types.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: {
  method: string;
  params?: Record<string, unknown>;
} | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: { content: "ok", isError: false } };

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
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

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerBrowserCommand } = await import("../browser.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = (() => true) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerBrowserCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return { exitCode, stdout: stdoutChunks.join("") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = {
    ok: true,
    result: { content: "ok", isError: false },
  };
  process.exitCode = 0;
  delete process.env.__CONVERSATION_ID;
  delete process.env.__SKILL_CONTEXT_JSON;
});

// ---------------------------------------------------------------------------
// Subcommand registration
// ---------------------------------------------------------------------------

describe("subcommand registration", () => {
  test("registers exactly 17 subcommands", () => {
    const program = new Command();
    registerBrowserCommand(program);
    const browser = program.commands.find((c) => c.name() === "browser");
    expect(browser).toBeDefined();
    const subcommands = browser!.commands;
    expect(subcommands).toHaveLength(17);
  });

  test("subcommand names match kebab-cased BROWSER_OPERATIONS", () => {
    const program = new Command();
    registerBrowserCommand(program);
    const browser = program.commands.find((c) => c.name() === "browser");
    const subcommandNames = browser!.commands.map((c) => c.name()).sort();
    const expectedNames = BROWSER_OPERATIONS.map((op) =>
      op.replace(/_/g, "-"),
    ).sort();
    expect(subcommandNames).toEqual(expectedNames);
  });

  test("all 17 operations from BROWSER_OPERATIONS are covered", () => {
    expect(BROWSER_OPERATIONS).toHaveLength(17);
    expect(BROWSER_OPERATION_META).toHaveLength(17);
  });
});

// ---------------------------------------------------------------------------
// Required-argument enforcement
// ---------------------------------------------------------------------------

describe("required-argument enforcement", () => {
  test("navigate requires --url", async () => {
    const { exitCode } = await runCommand(["browser", "navigate"]);
    expect(exitCode).not.toBe(0);
  });

  test("type requires --text", async () => {
    const { exitCode } = await runCommand(["browser", "type"]);
    expect(exitCode).not.toBe(0);
  });

  test("press-key requires --key", async () => {
    const { exitCode } = await runCommand(["browser", "press-key"]);
    expect(exitCode).not.toBe(0);
  });

  test("scroll requires --direction", async () => {
    const { exitCode } = await runCommand(["browser", "scroll"]);
    expect(exitCode).not.toBe(0);
  });

  test("fill-credential requires --service and --field", async () => {
    // Missing both
    const { exitCode: e1 } = await runCommand(["browser", "fill-credential"]);
    expect(e1).not.toBe(0);

    // Missing --field
    const { exitCode: e2 } = await runCommand([
      "browser",
      "fill-credential",
      "--service",
      "github",
    ]);
    expect(e2).not.toBe(0);

    // Missing --service
    const { exitCode: e3 } = await runCommand([
      "browser",
      "fill-credential",
      "--field",
      "token",
    ]);
    expect(e3).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// IPC payload mapping
// ---------------------------------------------------------------------------

describe("IPC payload mapping", () => {
  test("navigate sends correct operation and input", async () => {
    await runCommand(["browser", "navigate", "--url", "https://example.com"]);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("browser_execute");
    expect(lastIpcCall!.params!.operation).toBe("navigate");
    expect(lastIpcCall!.params!.input).toEqual({
      url: "https://example.com",
    });
    expect(lastIpcCall!.params!.sessionId).toBe("default");
  });

  test("navigate with --allow-private-network maps to allow_private_network", async () => {
    await runCommand([
      "browser",
      "navigate",
      "--url",
      "http://localhost:3000",
      "--allow-private-network",
    ]);
    expect(lastIpcCall!.params!.input).toEqual({
      url: "http://localhost:3000",
      allow_private_network: true,
    });
  });

  test("type maps --text, --element-id, --clear-first", async () => {
    await runCommand([
      "browser",
      "type",
      "--text",
      "hello world",
      "--element-id",
      "e14",
      "--clear-first",
    ]);
    expect(lastIpcCall!.params!.operation).toBe("type");
    expect(lastIpcCall!.params!.input).toEqual({
      text: "hello world",
      element_id: "e14",
      clear_first: true,
    });
  });

  test("scroll maps --direction and --amount (number coercion)", async () => {
    await runCommand([
      "browser",
      "scroll",
      "--direction",
      "down",
      "--amount",
      "300",
    ]);
    expect(lastIpcCall!.params!.operation).toBe("scroll");
    const input = lastIpcCall!.params!.input as Record<string, unknown>;
    expect(input.direction).toBe("down");
    expect(input.amount).toBe(300);
    expect(typeof input.amount).toBe("number");
  });

  test("press-key maps --key", async () => {
    await runCommand(["browser", "press-key", "--key", "Enter"]);
    expect(lastIpcCall!.params!.operation).toBe("press_key");
    expect(lastIpcCall!.params!.input).toEqual({ key: "Enter" });
  });

  test("fill-credential maps --service, --field, --press-enter", async () => {
    await runCommand([
      "browser",
      "fill-credential",
      "--service",
      "github",
      "--field",
      "token",
      "--press-enter",
    ]);
    expect(lastIpcCall!.params!.operation).toBe("fill_credential");
    expect(lastIpcCall!.params!.input).toEqual({
      service: "github",
      field: "token",
      press_enter: true,
    });
  });

  test("select-option maps to select_option operation", async () => {
    await runCommand([
      "browser",
      "select-option",
      "--value",
      "us",
      "--selector",
      "#country",
    ]);
    expect(lastIpcCall!.params!.operation).toBe("select_option");
    expect(lastIpcCall!.params!.input).toEqual({
      value: "us",
      selector: "#country",
    });
  });

  test("wait-for maps to wait_for operation", async () => {
    await runCommand([
      "browser",
      "wait-for",
      "--selector",
      ".loaded",
      "--timeout",
      "5000",
    ]);
    expect(lastIpcCall!.params!.operation).toBe("wait_for");
    const input = lastIpcCall!.params!.input as Record<string, unknown>;
    expect(input.selector).toBe(".loaded");
    expect(input.timeout).toBe(5000);
  });

  test("wait-for-download maps to wait_for_download operation", async () => {
    await runCommand(["browser", "wait-for-download"]);
    expect(lastIpcCall!.params!.operation).toBe("wait_for_download");
  });

  test("snapshot sends empty input", async () => {
    await runCommand(["browser", "snapshot"]);
    expect(lastIpcCall!.params!.operation).toBe("snapshot");
    expect(lastIpcCall!.params!.input).toEqual({});
  });

  test("screenshot sends empty input by default", async () => {
    await runCommand(["browser", "screenshot"]);
    expect(lastIpcCall!.params!.operation).toBe("screenshot");
    expect(lastIpcCall!.params!.input).toEqual({});
  });

  test("status maps --check-local-launch", async () => {
    await runCommand(["browser", "status", "--check-local-launch"]);
    expect(lastIpcCall!.params!.operation).toBe("status");
    expect(lastIpcCall!.params!.input).toEqual({
      check_local_launch: true,
    });
  });

  test("--session flag is passed through as sessionId", async () => {
    await runCommand([
      "browser",
      "--session",
      "myflow",
      "navigate",
      "--url",
      "https://example.com",
    ]);
    expect(lastIpcCall!.params!.sessionId).toBe("myflow");
  });

  test("default session is 'default'", async () => {
    await runCommand(["browser", "snapshot"]);
    expect(lastIpcCall!.params!.sessionId).toBe("default");
  });

  test("uses __CONVERSATION_ID for browser_execute when available", async () => {
    process.env.__CONVERSATION_ID = "conv-from-env";

    await runCommand(["browser", "status"]);

    expect(lastIpcCall!.params!.conversationId).toBe("conv-from-env");
  });

  test("prefers __SKILL_CONTEXT_JSON.conversationId over __CONVERSATION_ID", async () => {
    process.env.__CONVERSATION_ID = "conv-fallback";
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-from-skill",
    });

    await runCommand(["browser", "status"]);

    expect(lastIpcCall!.params!.conversationId).toBe("conv-from-skill");
  });

  test("falls back to __CONVERSATION_ID when __SKILL_CONTEXT_JSON is invalid", async () => {
    process.env.__CONVERSATION_ID = "conv-fallback";
    process.env.__SKILL_CONTEXT_JSON = "{invalid-json";

    await runCommand(["browser", "status"]);

    expect(lastIpcCall!.params!.conversationId).toBe("conv-fallback");
  });

  test("--browser-mode injects browser_mode into input", async () => {
    await runCommand([
      "browser",
      "--browser-mode",
      "local",
      "navigate",
      "--url",
      "http://localhost:3000",
    ]);
    expect(lastIpcCall!.params!.operation).toBe("navigate");
    const input = lastIpcCall!.params!.input as Record<string, unknown>;
    expect(input.browser_mode).toBe("local");
    expect(input.url).toBe("http://localhost:3000");
  });

  test("--browser-mode is omitted from input when not specified", async () => {
    await runCommand(["browser", "snapshot"]);
    const input = lastIpcCall!.params!.input as Record<string, unknown>;
    expect(input.browser_mode).toBeUndefined();
  });

  test("--browser-mode rejects invalid modes", async () => {
    const { exitCode } = await runCommand([
      "browser",
      "--browser-mode",
      "invalid",
      "snapshot",
    ]);
    expect(exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// --json and error exit-code behavior
// ---------------------------------------------------------------------------

describe("--json output", () => {
  test("--json outputs JSON with ok:true on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Page title: Example", isError: false },
    };

    const { exitCode, stdout } = await runCommand([
      "browser",
      "--json",
      "snapshot",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toBe("Page title: Example");
  });

  test("--json includes screenshots when present", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        content: "Screenshot taken",
        isError: false,
        screenshots: [{ mediaType: "image/jpeg", data: "abc123base64" }],
      },
    };

    const { exitCode, stdout } = await runCommand([
      "browser",
      "--json",
      "screenshot",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.screenshots).toHaveLength(1);
    expect(parsed.screenshots[0].mediaType).toBe("image/jpeg");
    expect(parsed.screenshots[0].data).toBe("abc123base64");
  });

  test("--json outputs ok:false when IPC connection fails", async () => {
    mockIpcResult = {
      ok: false,
      error: "Could not connect to assistant daemon. Is it running?",
    };

    const { exitCode, stdout } = await runCommand([
      "browser",
      "--json",
      "snapshot",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Could not connect");
  });

  test("--json outputs ok:false when operation returns isError:true", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        content: "Error: Element not found",
        isError: true,
      },
    };

    const { exitCode, stdout } = await runCommand([
      "browser",
      "--json",
      "click",
      "--selector",
      "#missing",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Error: Element not found");
  });
});

describe("error exit codes", () => {
  test("exits with non-zero code when IPC fails", async () => {
    mockIpcResult = {
      ok: false,
      error: "Connection refused",
    };

    const { exitCode } = await runCommand(["browser", "snapshot"]);
    expect(exitCode).toBe(1);
  });

  test("exits with non-zero code when operation returns error", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        content: "Error: Navigation failed",
        isError: true,
      },
    };

    const { exitCode } = await runCommand([
      "browser",
      "navigate",
      "--url",
      "https://broken.test",
    ]);
    expect(exitCode).toBe(1);
  });

  test("exits with zero code on successful operation", async () => {
    mockIpcResult = {
      ok: true,
      result: { content: "Done", isError: false },
    };

    const { exitCode } = await runCommand([
      "browser",
      "navigate",
      "--url",
      "https://example.com",
    ]);
    expect(exitCode).toBe(0);
  });
});
