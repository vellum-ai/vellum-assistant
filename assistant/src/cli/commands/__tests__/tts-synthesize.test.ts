/**
 * Tests for the `assistant tts synthesize` CLI command.
 *
 * Validates:
 *   - Help text renders correctly for `tts` and `tts synthesize`
 *   - Error when the provider is not configured (TTS_PROVIDER_NOT_CONFIGURED)
 *   - Generic synthesis failure (TTS_SYNTHESIS_FAILED)
 *   - Success case: writes audio to a temp file and prints its path
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

interface MockSynthesisResult {
  audio: Buffer;
  contentType: string;
}

let mockSynthesisResult: MockSynthesisResult = {
  audio: Buffer.from("fake-audio"),
  contentType: "audio/mpeg",
};
let mockSynthesizeThrow: Error | null = null;
let mockSynthesizeTextArg: string | undefined;
let logErrorMessages: string[] = [];
let writeFileCalls: Array<{ path: string; buffer: Buffer }> = [];
let mkdirCalls: Array<{ path: string; options: unknown }> = [];
let readFileSyncImpl: (path: string, encoding: string) => string = () => {
  throw new Error("stdin unavailable");
};

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

mock.module("../../../config/assistant-feature-flags.js", () => ({
  initFeatureFlagOverrides: async () => {},
  _setOverridesForTesting: () => {},
  isFeatureEnabled: () => true,
}));

mock.module("../../../tts/synthesize-text.js", () => ({
  synthesizeText: async (args: { text: string }) => {
    mockSynthesizeTextArg = args.text;
    if (mockSynthesizeThrow) throw mockSynthesizeThrow;
    return mockSynthesisResult;
  },
  TtsSynthesisError: class TtsSynthesisError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "TtsSynthesisError";
      this.code = code;
    }
  },
}));

mock.module("../../../tts/providers/register-builtins.js", () => ({
  registerBuiltinTtsProviders: () => {},
}));

mock.module("node:fs", () => ({
  existsSync: () => true,
  mkdirSync: (path: string, options: unknown) => {
    mkdirCalls.push({ path, options });
  },
  readFileSync: (path: string, encoding: string) =>
    readFileSyncImpl(path, encoding),
  writeFileSync: (path: string, buffer: Buffer) => {
    writeFileCalls.push({ path, buffer });
  },
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerTtsCommand } = await import("../tts.js");
const { TtsSynthesisError } = await import("../../../tts/synthesize-text.js");

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
    registerTtsCommand(program);
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
  mockSynthesisResult = {
    audio: Buffer.from("fake-audio"),
    contentType: "audio/mpeg",
  };
  mockSynthesizeThrow = null;
  mockSynthesizeTextArg = undefined;
  logErrorMessages = [];
  writeFileCalls = [];
  mkdirCalls = [];
  readFileSyncImpl = () => {
    throw new Error("stdin unavailable");
  };
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

describe("help text", () => {
  test("tts --help renders command group with examples", async () => {
    const { stdout } = await runCommand(["tts", "--help"]);
    expect(stdout).toContain("Text-to-speech");
    expect(stdout).toContain("assistant tts synthesize");
  });

  test("tts synthesize --help renders argument docs and examples", async () => {
    const { stdout } = await runCommand(["tts", "synthesize", "--help"]);
    expect(stdout).toContain("--text");
    expect(stdout).toContain("assistant tts synthesize --text");
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("error cases", () => {
  test("provider not configured exits with code 1 and actionable error", async () => {
    mockSynthesizeThrow = new TtsSynthesisError(
      "TTS_PROVIDER_NOT_CONFIGURED",
      "not registered",
    );

    const { exitCode, stderr } = await runCommand([
      "tts",
      "synthesize",
      "--text",
      "hello",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("assistant config set services.tts.provider");
  });

  test("generic synthesis failure exits with code 1 and includes error message", async () => {
    mockSynthesizeThrow = new TtsSynthesisError(
      "TTS_SYNTHESIS_FAILED",
      "upstream 500",
    );

    const { exitCode, stderr } = await runCommand([
      "tts",
      "synthesize",
      "--text",
      "hello",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("upstream 500");
  });
});

// ---------------------------------------------------------------------------
// Success case
// ---------------------------------------------------------------------------

describe("success cases", () => {
  test("synthesizes text, writes audio to temp dir, prints file path", async () => {
    mockSynthesisResult = {
      audio: Buffer.from("fake-audio"),
      contentType: "audio/mpeg",
    };

    const { exitCode, stdout } = await runCommand([
      "tts",
      "synthesize",
      "--text",
      "hello",
    ]);

    expect(exitCode).toBe(0);
    expect(writeFileCalls.length).toBe(1);

    const call = writeFileCalls[0];
    expect(call.path).toContain("vellum-tts-");
    expect(call.path.endsWith(".mp3")).toBe(true);
    expect(call.buffer.equals(Buffer.from("fake-audio"))).toBe(true);

    expect(stdout).toContain(call.path);
  });
});

// ---------------------------------------------------------------------------
// Flexible input
// ---------------------------------------------------------------------------

describe("flexible input", () => {
  test("positional args are joined with spaces and passed as text", async () => {
    const { exitCode } = await runCommand([
      "tts",
      "synthesize",
      "hello",
      "world",
    ]);

    expect(exitCode).toBe(0);
    expect(mockSynthesizeTextArg).toBe("hello world");
    expect(writeFileCalls.length).toBe(1);
  });

  test("stdin fallback is used when no --text or positional arg is given", async () => {
    readFileSyncImpl = (path: string) => {
      if (path === "/dev/stdin") return "piped text\n";
      throw new Error("unexpected readFileSync call");
    };

    const { exitCode } = await runCommand(["tts", "synthesize"]);

    expect(exitCode).toBe(0);
    expect(mockSynthesizeTextArg).toBe("piped text");
  });

  test("empty input from every channel exits 1 with actionable error", async () => {
    readFileSyncImpl = () => {
      throw new Error("stdin unavailable");
    };

    const { exitCode, stderr } = await runCommand(["tts", "synthesize"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("No text provided");
    expect(mockSynthesizeTextArg).toBeUndefined();
    expect(writeFileCalls.length).toBe(0);
  });

  test("--output override writes to the given path and creates parent dir", async () => {
    const { exitCode } = await runCommand([
      "tts",
      "synthesize",
      "--text",
      "hello",
      "--output",
      "/custom/path/out.mp3",
    ]);

    expect(exitCode).toBe(0);
    expect(writeFileCalls.length).toBe(1);
    expect(writeFileCalls[0].path).toBe("/custom/path/out.mp3");

    const mkdirForParent = mkdirCalls.find((c) => c.path === "/custom/path");
    expect(mkdirForParent).toBeDefined();
    expect(mkdirForParent?.options).toEqual({ recursive: true });
  });
});
