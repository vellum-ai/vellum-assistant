/**
 * Tests for the `assistant tts` CLI command group (IPC transport).
 *
 * Validates:
 *   - synthesize --text forwards text and default useCase to tts_synthesize_cli
 *   - --voice is forwarded as voiceId
 *   - --use-case phone-call is forwarded correctly
 *   - --json with success emits structured JSON on stdout
 *   - IPC error sets non-zero exit code
 *   - No text provided exits with code 1 without calling IPC
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: { method: string; params?: any } | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: { ok: boolean; result?: unknown; error?: string } = {
  ok: true,
  result: { audioBase64: "dGVzdA==", contentType: "audio/mpeg" },
};

/** Captured writeFileSync calls. */
let writeFileCalls: Array<{ path: string; data: Buffer }> = [];

/** Controls whether stdin mock returns text or throws. */
let stdinReturnsText = false;

// ---------------------------------------------------------------------------
// Mocks — must be declared before module-under-test import
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: any) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitFromIpcResult: (r: any) => {
    process.exitCode = 1;
    throw new Error(r.error ?? "ipc error");
  },
}));

mock.module("../../logger.js", () => ({
  log: {
    error: (msg: string) => {
      process.stderr.write(String(msg) + "\n");
    },
    info: () => {},
    warn: () => {},
    debug: () => {},
  },
}));

mock.module("node:fs", () => ({
  existsSync: () => true,
  mkdirSync: () => {},
  readFileSync: (path: string) => {
    if (path === "/dev/stdin") {
      if (stdinReturnsText) return "piped text";
      throw new Error("stdin unavailable");
    }
    throw new Error("unexpected readFileSync call");
  },
  writeFileSync: (path: string, data: Buffer) => {
    writeFileCalls.push({ path, data });
  },
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerTtsCommand } = await import("../tts.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  registerTtsCommand(program);
  return program;
}

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const localStdout: string[] = [];
  const localStderr: string[] = [];

  // Suppress isTTY so stdin fallback is reachable in test environments.
  const originalIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    value: undefined,
    configurable: true,
  });

  process.stdout.write = ((chunk: unknown) => {
    const s = typeof chunk === "string" ? chunk : String(chunk);
    localStdout.push(s);
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    localStderr.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = buildProgram();
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

  return { exitCode, stdout: localStdout.join(""), stderr: localStderr.join("") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = {
    ok: true,
    result: { audioBase64: "dGVzdA==", contentType: "audio/mpeg" },
  };
  writeFileCalls = [];
  stdinReturnsText = false;
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// synthesize — basic IPC dispatch
// ---------------------------------------------------------------------------

describe("tts synthesize — IPC dispatch", () => {
  test("--text 'hello world' sends tts_synthesize_cli with text and default useCase", async () => {
    const { exitCode } = await runCommand([
      "tts",
      "synthesize",
      "--text",
      "hello world",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).not.toBeNull();
    expect(lastIpcCall!.method).toBe("tts_synthesize_cli");
    expect(lastIpcCall!.params.body.text).toBe("hello world");
    expect(lastIpcCall!.params.body.useCase).toBe("message-playback");
  });

  test("--voice my-voice-id is forwarded as voiceId", async () => {
    const { exitCode } = await runCommand([
      "tts",
      "synthesize",
      "--text",
      "hi",
      "--voice",
      "my-voice-id",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params.body.voiceId).toBe("my-voice-id");
  });

  test("--use-case phone-call is forwarded correctly", async () => {
    const { exitCode } = await runCommand([
      "tts",
      "synthesize",
      "--text",
      "hi",
      "--use-case",
      "phone-call",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params.body.useCase).toBe("phone-call");
  });

  test("no --voice flag omits voiceId from params", async () => {
    await runCommand(["tts", "synthesize", "--text", "hi"]);

    expect(lastIpcCall!.params.body.voiceId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// synthesize — JSON output
// ---------------------------------------------------------------------------

describe("tts synthesize — --json output", () => {
  test("success with --json emits structured JSON on stdout", async () => {
    mockIpcResult = {
      ok: true,
      result: { audioBase64: "dGVzdA==", contentType: "audio/mpeg" },
    };

    const { exitCode, stdout } = await runCommand([
      "tts",
      "synthesize",
      "--text",
      "hi",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.path).toBe("string");
    expect(parsed.contentType).toBe("audio/mpeg");
    expect(typeof parsed.sizeBytes).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// synthesize — IPC error path
// ---------------------------------------------------------------------------

describe("tts synthesize — IPC error", () => {
  test("IPC error sets non-zero exit code", async () => {
    mockIpcResult = { ok: false, error: "daemon error" };

    const { exitCode } = await runCommand([
      "tts",
      "synthesize",
      "--text",
      "hi",
    ]);

    expect(exitCode).not.toBe(0);
  });

  test("IPC error with --json emits JSON error on stdout", async () => {
    mockIpcResult = { ok: false, error: "daemon error" };

    const { exitCode, stdout } = await runCommand([
      "tts",
      "synthesize",
      "--text",
      "hi",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("daemon error");
  });
});

// ---------------------------------------------------------------------------
// synthesize — no text provided
// ---------------------------------------------------------------------------

describe("tts synthesize — no text", () => {
  test("no text provided exits code 1 without calling IPC", async () => {
    // stdinReturnsText is false (default), so stdin reading will throw.
    const { exitCode } = await runCommand(["tts", "synthesize"]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// synthesize — audio bytes round-trip
// ---------------------------------------------------------------------------

describe("tts synthesize — base64 round-trip", () => {
  test("decoded audio bytes written to disk are byte-identical to what the daemon returns", async () => {
    const originalBytes = Buffer.from([0x49, 0x44, 0x33, 0x04]);
    const audioBase64 = originalBytes.toString("base64");

    mockIpcResult = {
      ok: true,
      result: { audioBase64, contentType: "audio/mpeg" },
    };

    const { exitCode } = await runCommand([
      "tts",
      "synthesize",
      "--text",
      "hi",
    ]);

    expect(exitCode).toBe(0);
    expect(writeFileCalls.length).toBe(1);
    expect(Buffer.from(writeFileCalls[0].data).equals(originalBytes)).toBe(
      true,
    );
  });
});
