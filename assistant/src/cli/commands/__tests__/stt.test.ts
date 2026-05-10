/**
 * Tests for the `assistant stt` CLI command group (IPC transport).
 *
 * Validates:
 *   - `stt transcribe --file <audio>` maps to the stt_transcribe_file IPC method
 *   - `stt transcribe --file <video>` maps to the same method with correct filePath
 *   - `--json` flag produces structured JSON on stdout
 *   - Client-side extension validation rejects unsupported types without calling IPC
 *   - IPC error path sets process.exitCode = 1
 *   - Empty transcript produces "No speech detected" output
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: { method: string; params?: any } | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = {
  ok: true,
  result: { transcript: "hello world", provider: "openai-whisper", durationSeconds: 1.5 },
};

/** Captured log output for assertion. */
let logOutput: string[] = [];

// ---------------------------------------------------------------------------
// Mocks — must be before module-under-test import
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

const capture = (...args: unknown[]) => {
  logOutput.push(args.map(String).join(" "));
};
const fakeLogger = {
  info: capture,
  warn: capture,
  error: capture,
  debug: () => {},
};
mock.module("../../logger.js", () => ({
  log: fakeLogger,
  getCliLogger: () => fakeLogger,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerSttCommand } = await import("../stt.js");

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
  registerSttCommand(program);
  return program;
}

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
    const program = buildProgram();
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
    result: { transcript: "hello world", provider: "openai-whisper", durationSeconds: 1.5 },
  };
  logOutput = [];
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// IPC routing — audio file
// ---------------------------------------------------------------------------

describe("stt transcribe audio file", () => {
  test("calls stt_transcribe_file with correct filePath for .wav", async () => {
    const { exitCode } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/tmp/audio.wav",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).not.toBeNull();
    expect(lastIpcCall!.method).toBe("stt_transcribe_file");
    expect(lastIpcCall!.params.body.filePath).toBe("/tmp/audio.wav");
  });

  test("prints transcript to stdout on success", async () => {
    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/tmp/audio.wav",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("hello world");
  });
});

// ---------------------------------------------------------------------------
// IPC routing — video file
// ---------------------------------------------------------------------------

describe("stt transcribe video file", () => {
  test("calls stt_transcribe_file with correct filePath for .mp4", async () => {
    const { exitCode } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/tmp/video.mp4",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).not.toBeNull();
    expect(lastIpcCall!.method).toBe("stt_transcribe_file");
    expect(lastIpcCall!.params.body.filePath).toBe("/tmp/video.mp4");
  });
});

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

describe("--json flag", () => {
  test("outputs JSON with ok: true and transcript fields", async () => {
    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/tmp/audio.wav",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.transcript).toBe("hello world");
    expect(parsed.provider).toBe("openai-whisper");
    expect(typeof parsed.durationSeconds).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Client-side extension validation (no IPC call)
// ---------------------------------------------------------------------------

describe("client-side extension validation", () => {
  test("unsupported extension exits with code 1 without calling IPC", async () => {
    const { exitCode } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/tmp/audio.xyz",
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("unsupported extension with --json outputs JSON error to stdout", async () => {
    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/tmp/audio.xyz",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Unsupported file type");
  });
});

// ---------------------------------------------------------------------------
// IPC error path
// ---------------------------------------------------------------------------

describe("IPC error path", () => {
  test("IPC failure sets process.exitCode = 1", async () => {
    mockIpcResult = { ok: false, error: "provider not configured" };

    const { exitCode } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/tmp/audio.wav",
    ]);

    expect(exitCode).toBe(1);
  });

  test("IPC failure with --json outputs JSON error to stdout", async () => {
    mockIpcResult = { ok: false, error: "provider not configured" };

    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/tmp/audio.wav",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("provider not configured");
  });
});

// ---------------------------------------------------------------------------
// Empty transcript
// ---------------------------------------------------------------------------

describe("empty transcript", () => {
  test("empty transcript prints 'No speech detected' to stdout", async () => {
    mockIpcResult = {
      ok: true,
      result: { transcript: "", provider: "openai-whisper", durationSeconds: 0.5 },
    };

    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/tmp/audio.wav",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("No speech detected");
  });

  test("empty transcript with --json outputs ok: true with empty transcript", async () => {
    mockIpcResult = {
      ok: true,
      result: { transcript: "", provider: "openai-whisper", durationSeconds: 0.5 },
    };

    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/tmp/audio.wav",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.transcript).toBe("");
    expect(parsed.provider).toBe("openai-whisper");
  });
});
