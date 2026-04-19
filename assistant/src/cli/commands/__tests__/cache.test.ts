/**
 * Tests for the `assistant cache` CLI command.
 *
 * Validates:
 *   - Subcommand registration (set, get, delete)
 *   - `set` payload parsing from stdin + IPC param mapping
 *   - TTL parsing edge cases (ms, s, m, h, invalid)
 *   - >1 MB payload warning path
 *   - `get` success, miss, and error output
 *   - `delete` success and error output
 *   - JSON output shape and exit-code behavior on IPC errors
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
} | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: { key: "test-key" } };

/** Simulated stdin content for the next command run. */
let mockStdinContent: string | null = null;

/** Whether to simulate stdin as a TTY (no piped input). */
let mockStdinIsTTY: boolean = false;

/** Captured stderr output for warning assertions. */
let stderrChunks: string[] = [];

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
    warn: (...args: unknown[]) => {
      stderrChunks.push(args.map(String).join(" "));
    },
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: () => {},
    warn: (...args: unknown[]) => {
      stderrChunks.push(args.map(String).join(" "));
    },
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

const { registerCacheCommand } = await import("../cache.js");

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

  // Save and mock isTTY
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
    registerCacheCommand(program);
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
  mockIpcResult = { ok: true, result: { key: "test-key" } };
  mockStdinContent = null;
  mockStdinIsTTY = false;
  stderrChunks = [];
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Subcommand registration
// ---------------------------------------------------------------------------

describe("subcommand registration", () => {
  test("registers set, get, delete subcommands under cache", () => {
    const program = new Command();
    registerCacheCommand(program);
    const cache = program.commands.find((c) => c.name() === "cache");
    expect(cache).toBeDefined();
    const subcommandNames = cache!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual(["delete", "get", "set"]);
  });
});

// ---------------------------------------------------------------------------
// set — payload parsing + IPC params
// ---------------------------------------------------------------------------

describe("cache set", () => {
  test("parses JSON from stdin and sends cache/set IPC", async () => {
    mockStdinContent = '{"scores":[98,85,72]}';
    mockIpcResult = { ok: true, result: { key: "generated-key" } };

    const { exitCode } = await runCommand(["cache", "set"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("cache/set");
    expect(lastIpcCall!.params!.data).toEqual({ scores: [98, 85, 72] });
    expect(lastIpcCall!.params!.ttl_ms).toBeUndefined();
    expect(lastIpcCall!.params!.key).toBeUndefined();
  });

  test("passes --key to IPC params", async () => {
    mockStdinContent = '"hello"';
    mockIpcResult = { ok: true, result: { key: "my-key" } };

    await runCommand(["cache", "set", "--key", "my-key"]);

    expect(lastIpcCall!.params!.key).toBe("my-key");
  });

  test("passes --ttl as ttl_ms in IPC params", async () => {
    mockStdinContent = "42";
    mockIpcResult = { ok: true, result: { key: "k" } };

    await runCommand(["cache", "set", "--ttl", "5m"]);

    expect(lastIpcCall!.params!.ttl_ms).toBe(300_000);
  });

  test("--json outputs JSON with ok:true and key on success", async () => {
    mockStdinContent = '{"a":1}';
    mockIpcResult = { ok: true, result: { key: "abc-123" } };

    const { exitCode, stdout } = await runCommand(["cache", "set", "--json"]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, key: "abc-123" });
  });

  test("errors on empty stdin", async () => {
    mockStdinContent = "   ";

    const { exitCode } = await runCommand(["cache", "set"]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("errors on invalid JSON", async () => {
    mockStdinContent = "{not json}";

    const { exitCode } = await runCommand(["cache", "set"]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("errors on TTY stdin (no pipe)", async () => {
    mockStdinIsTTY = true;

    const { exitCode } = await runCommand(["cache", "set"]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("--json outputs error on invalid JSON stdin", async () => {
    mockStdinContent = "{bad}";

    const { exitCode, stdout } = await runCommand(["cache", "set", "--json"]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid JSON");
  });

  test("--json outputs error on IPC failure", async () => {
    mockStdinContent = '"data"';
    mockIpcResult = {
      ok: false,
      error: "Could not connect to assistant daemon. Is it running?",
    };

    const { exitCode, stdout } = await runCommand(["cache", "set", "--json"]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Could not connect");
  });
});

// ---------------------------------------------------------------------------
// set — TTL parsing edge cases
// ---------------------------------------------------------------------------

describe("TTL parsing", () => {
  test("parses milliseconds", async () => {
    mockStdinContent = "1";
    mockIpcResult = { ok: true, result: { key: "k" } };

    await runCommand(["cache", "set", "--ttl", "1000ms"]);

    expect(lastIpcCall!.params!.ttl_ms).toBe(1000);
  });

  test("parses seconds", async () => {
    mockStdinContent = "1";
    mockIpcResult = { ok: true, result: { key: "k" } };

    await runCommand(["cache", "set", "--ttl", "30s"]);

    expect(lastIpcCall!.params!.ttl_ms).toBe(30_000);
  });

  test("parses minutes", async () => {
    mockStdinContent = "1";
    mockIpcResult = { ok: true, result: { key: "k" } };

    await runCommand(["cache", "set", "--ttl", "10m"]);

    expect(lastIpcCall!.params!.ttl_ms).toBe(600_000);
  });

  test("parses hours", async () => {
    mockStdinContent = "1";
    mockIpcResult = { ok: true, result: { key: "k" } };

    await runCommand(["cache", "set", "--ttl", "2h"]);

    expect(lastIpcCall!.params!.ttl_ms).toBe(7_200_000);
  });

  test("rejects invalid TTL format", async () => {
    mockStdinContent = "1";

    const { exitCode } = await runCommand(["cache", "set", "--ttl", "5days"]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("rejects TTL without unit", async () => {
    mockStdinContent = "1";

    const { exitCode } = await runCommand(["cache", "set", "--ttl", "100"]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("--json outputs error on invalid TTL", async () => {
    mockStdinContent = "1";

    const { exitCode, stdout } = await runCommand([
      "cache",
      "set",
      "--ttl",
      "bad",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid --ttl");
  });

  test("rejects sub-second TTL (100ms)", async () => {
    mockStdinContent = "1";
    const { exitCode } = await runCommand(["cache", "set", "--ttl", "100ms"]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("rejects sub-second TTL (500ms)", async () => {
    mockStdinContent = "1";
    const { exitCode } = await runCommand(["cache", "set", "--ttl", "500ms"]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("rejects sub-second TTL (999ms)", async () => {
    mockStdinContent = "1";
    const { exitCode } = await runCommand(["cache", "set", "--ttl", "999ms"]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("accepts exactly 1000ms", async () => {
    mockStdinContent = "1";
    mockIpcResult = { ok: true, result: { key: "k" } };
    await runCommand(["cache", "set", "--ttl", "1000ms"]);
    expect(lastIpcCall!.params!.ttl_ms).toBe(1000);
  });

  test("accepts 1s", async () => {
    mockStdinContent = "1";
    mockIpcResult = { ok: true, result: { key: "k" } };
    await runCommand(["cache", "set", "--ttl", "1s"]);
    expect(lastIpcCall!.params!.ttl_ms).toBe(1000);
  });

  test("accepts 1500ms (resolves to >= 1s)", async () => {
    mockStdinContent = "1";
    mockIpcResult = { ok: true, result: { key: "k" } };
    await runCommand(["cache", "set", "--ttl", "1500ms"]);
    expect(lastIpcCall!.params!.ttl_ms).toBe(1500);
  });

  test("--json outputs error on sub-second TTL", async () => {
    mockStdinContent = "1";
    const { exitCode, stdout } = await runCommand([
      "cache",
      "set",
      "--ttl",
      "500ms",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("at least 1s");
  });

  test("rejects empty string TTL", async () => {
    mockStdinContent = "1";
    const { exitCode } = await runCommand(["cache", "set", "--ttl", ""]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("--json outputs error on empty string TTL", async () => {
    mockStdinContent = "1";
    const { exitCode, stdout } = await runCommand([
      "cache",
      "set",
      "--ttl",
      "",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Invalid --ttl value ""');
  });
});

// ---------------------------------------------------------------------------
// set — >1 MB warning
// ---------------------------------------------------------------------------

describe(">1 MB warning", () => {
  test("warns on payloads exceeding 1 MB but still succeeds", async () => {
    // Create a payload larger than 1 MB
    const largeString = "x".repeat(1_100_000);
    mockStdinContent = JSON.stringify(largeString);
    mockIpcResult = { ok: true, result: { key: "big-key" } };

    const { exitCode, stderr } = await runCommand(["cache", "set"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("cache/set");
    // Warning is written directly to stderr (not through the logger)
    expect(stderr).toContain("exceeds 1 MB");
  });

  test("does not warn on payloads under 1 MB", async () => {
    mockStdinContent = '{"small": true}';
    mockIpcResult = { ok: true, result: { key: "k" } };

    const { stderr } = await runCommand(["cache", "set"]);

    expect(stderr).not.toContain("exceeds 1 MB");
  });
});

// ---------------------------------------------------------------------------
// get — success, miss, and error
// ---------------------------------------------------------------------------

describe("cache get", () => {
  test("prints data on cache hit", async () => {
    mockIpcResult = { ok: true, result: { data: { foo: "bar" } } };

    const { exitCode } = await runCommand(["cache", "get", "my-key"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("cache/get");
    expect(lastIpcCall!.params).toEqual({ key: "my-key" });
  });

  test("--json outputs { ok: true, data: ... } on hit", async () => {
    mockIpcResult = { ok: true, result: { data: [1, 2, 3] } };

    const { exitCode, stdout } = await runCommand([
      "cache",
      "get",
      "my-key",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, data: [1, 2, 3] });
  });

  test("--json outputs { ok: true, data: null } on miss", async () => {
    mockIpcResult = { ok: true, result: null };

    const { exitCode, stdout } = await runCommand([
      "cache",
      "get",
      "missing-key",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, data: null });
  });

  test("exits with error on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand(["cache", "get", "some-key"]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs error on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode, stdout } = await runCommand([
      "cache",
      "get",
      "some-key",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: false, error: "Connection refused" });
  });
});

// ---------------------------------------------------------------------------
// delete — success and error
// ---------------------------------------------------------------------------

describe("cache delete", () => {
  test("sends cache/delete IPC and succeeds", async () => {
    mockIpcResult = { ok: true, result: { deleted: true } };

    const { exitCode } = await runCommand(["cache", "delete", "my-key"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("cache/delete");
    expect(lastIpcCall!.params).toEqual({ key: "my-key" });
  });

  test("--json outputs { ok: true, deleted: true } on success", async () => {
    mockIpcResult = { ok: true, result: { deleted: true } };

    const { exitCode, stdout } = await runCommand([
      "cache",
      "delete",
      "my-key",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, deleted: true });
  });

  test("--json outputs { ok: true, deleted: false } when key did not exist", async () => {
    mockIpcResult = { ok: true, result: { deleted: false } };

    const { exitCode, stdout } = await runCommand([
      "cache",
      "delete",
      "missing-key",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: true, deleted: false });
  });

  test("exits with error on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand(["cache", "delete", "some-key"]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs error on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Timeout" };

    const { exitCode, stdout } = await runCommand([
      "cache",
      "delete",
      "some-key",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: false, error: "Timeout" });
  });
});
