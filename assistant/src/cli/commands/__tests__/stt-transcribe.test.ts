/**
 * Tests for the `assistant stt transcribe` CLI command.
 *
 * Validates:
 *   - Help text renders correctly for `stt` and `stt transcribe`
 *   - Error when --file points to a nonexistent file
 *   - Error when no STT provider is configured
 *   - Success case with mocked transcriber
 *   - --json output format
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import type { BatchTranscriber } from "../../../stt/types.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockAccessResult: "ok" | Error = "ok";
let mockTranscriber: BatchTranscriber | null = null;
let mockSpawnResult = {
  exitCode: 0,
  stdout: "120.5",
  stderr: "",
};
let mockFileSize = 1024;
let logErrorMessages: string[] = [];

// ---------------------------------------------------------------------------
// Mocks — must be before module-under-test import
// ---------------------------------------------------------------------------

mock.module("../../logger.js", () => ({
  log: {
    error: (msg: string) => {
      logErrorMessages.push(msg);
      process.stderr.write(msg + "\n");
    },
    info: () => {},
    warn: () => {},
    debug: () => {},
  },
}));

mock.module("node:fs/promises", () => ({
  access: async () => {
    if (mockAccessResult !== "ok") throw mockAccessResult;
  },
  readFile: async () => Buffer.from("fake-audio-data"),
  unlink: async () => {},
  mkdir: async () => {},
  readdir: async () => [],
  rm: async () => {},
}));

mock.module("../../../providers/speech-to-text/resolve.js", () => ({
  resolveBatchTranscriber: async () => mockTranscriber,
}));

mock.module("../../../util/spawn.js", () => ({
  FFMPEG_TRANSCODE_TIMEOUT_MS: 120_000,
  FFPROBE_TIMEOUT_MS: 15_000,
  spawnWithTimeout: async () => mockSpawnResult,
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({ services: { stt: { provider: "openai-whisper" } } }),
  getConfigReadOnly: () => ({
    services: { stt: { provider: "openai-whisper" } },
  }),
}));

mock.module("../../../config/assistant-feature-flags.js", () => ({
  initFeatureFlagOverrides: async () => {},
  _setOverridesForTesting: () => {},
  isFeatureEnabled: () => true,
}));

// Mock Bun.file for file size checks
const _originalBunFile = Bun.file;
Bun.file = ((_path: string) => ({
  size: mockFileSize,
})) as typeof Bun.file;

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerSttCommand } = await import("../stt.js");

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

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  process.exitCode = 0;

  // Mock process.exit to throw so we can capture it
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    process.exitCode = code ?? 0;
    throw new Error(`__EXIT_${code ?? 0}__`);
  }) as typeof process.exit;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: (str: string) => stderrChunks.push(str),
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerSttCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    /* commander exit override or process.exit mock throws */
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
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
  mockAccessResult = "ok";
  mockTranscriber = null;
  mockSpawnResult = { exitCode: 0, stdout: "120.5", stderr: "" };
  mockFileSize = 1024;
  logErrorMessages = [];
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

describe("help text", () => {
  test("stt --help renders command group with examples", async () => {
    const { stdout } = await runCommand(["stt", "--help"]);
    expect(stdout).toContain("Speech-to-text operations");
    expect(stdout).toContain("assistant config set services.stt.provider");
    expect(stdout).toContain("assistant stt transcribe");
  });

  test("stt transcribe --help renders argument docs and examples", async () => {
    const { stdout } = await runCommand(["stt", "transcribe", "--help"]);
    expect(stdout).toContain("--file <path>");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("Supported audio formats");
    expect(stdout).toContain("Supported video formats");
    expect(stdout).toContain("ffmpeg");
    expect(stdout).toContain("assistant stt transcribe --file");
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("error cases", () => {
  test("nonexistent file exits with code 1 and actionable error", async () => {
    mockAccessResult = new Error("ENOENT");

    const { exitCode, stderr } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/nonexistent/audio.wav",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("File not found: /nonexistent/audio.wav");
  });

  test("no STT provider configured exits with code 1 and actionable error", async () => {
    mockAccessResult = "ok";
    mockTranscriber = null;

    const { exitCode, stderr } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/path/to/audio.wav",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("No speech-to-text provider is configured");
    expect(stderr).toContain("assistant config set services.stt.provider");
  });

  test("unsupported file type exits with code 1", async () => {
    mockAccessResult = "ok";

    const { exitCode, stderr } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/path/to/document.pdf",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unsupported file type");
  });

  test("nonexistent file with --json outputs JSON error to stdout", async () => {
    mockAccessResult = new Error("ENOENT");

    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/nonexistent/audio.wav",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("File not found");
  });

  test("no STT provider with --json outputs JSON error to stdout", async () => {
    mockAccessResult = "ok";
    mockTranscriber = null;

    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/path/to/audio.wav",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No speech-to-text provider is configured");
  });

  test("unsupported file type with --json outputs JSON error to stdout", async () => {
    mockAccessResult = "ok";

    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/path/to/document.pdf",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Unsupported file type");
  });
});

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

describe("success cases", () => {
  const fakeTranscriber: BatchTranscriber = {
    providerId: "openai-whisper",
    boundaryId: "daemon-batch",
    transcribe: async () => ({ text: "Hello, this is a test transcript." }),
  };

  test("transcribes audio file and prints transcript to stdout", async () => {
    mockAccessResult = "ok";
    mockTranscriber = fakeTranscriber;
    mockFileSize = 1024;

    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/path/to/audio.wav",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Hello, this is a test transcript.");
  });

  test("transcribes video file (auto-extracts audio)", async () => {
    mockAccessResult = "ok";
    mockTranscriber = fakeTranscriber;
    mockFileSize = 1024;

    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/path/to/video.mp4",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Hello, this is a test transcript.");
  });

  test("--json output contains expected fields", async () => {
    mockAccessResult = "ok";
    mockTranscriber = fakeTranscriber;
    mockFileSize = 1024;

    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/path/to/audio.wav",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.transcript).toBe("Hello, this is a test transcript.");
    expect(parsed.provider).toBe("openai-whisper");
    expect(typeof parsed.durationSeconds).toBe("number");
  });

  test("no speech detected prints appropriate message", async () => {
    mockAccessResult = "ok";
    mockTranscriber = {
      ...fakeTranscriber,
      transcribe: async () => ({ text: "" }),
    };
    mockFileSize = 1024;

    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/path/to/silence.wav",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("No speech detected");
  });

  test("no speech detected with --json returns empty transcript", async () => {
    mockAccessResult = "ok";
    mockTranscriber = {
      ...fakeTranscriber,
      transcribe: async () => ({ text: "" }),
    };
    mockFileSize = 1024;

    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/path/to/silence.wav",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.transcript).toBe("");
    expect(parsed.provider).toBe("openai-whisper");
  });
});

// ---------------------------------------------------------------------------
// Transcription failure
// ---------------------------------------------------------------------------

describe("transcription failure", () => {
  test("ffmpeg failure exits with code 1 and error message", async () => {
    mockAccessResult = "ok";
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => ({ text: "ok" }),
    };
    mockSpawnResult = {
      exitCode: 1,
      stdout: "",
      stderr: "ffmpeg error: codec not found",
    };
    mockFileSize = 1024;

    const { exitCode, stderr } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/path/to/audio.wav",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Transcription failed");
  });

  test("ffmpeg failure with --json outputs JSON error to stdout", async () => {
    mockAccessResult = "ok";
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => ({ text: "ok" }),
    };
    mockSpawnResult = {
      exitCode: 1,
      stdout: "",
      stderr: "ffmpeg error: codec not found",
    };
    mockFileSize = 1024;

    const { exitCode, stdout } = await runCommand([
      "stt",
      "transcribe",
      "--file",
      "/path/to/audio.wav",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Transcription failed");
  });
});
