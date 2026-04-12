import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BatchTranscriber } from "../../../../stt/types.js";
import type { ToolContext } from "../../../../tools/types.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the subject import
// ---------------------------------------------------------------------------

mock.module("../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let mockTranscriber: BatchTranscriber | null = null;

mock.module("../../../../providers/speech-to-text/resolve.js", () => ({
  resolveBatchTranscriber: async () => mockTranscriber,
}));

// Track calls to spawnWithTimeout so we can simulate ffmpeg/ffprobe results.
let spawnResults: Record<
  string,
  { exitCode: number; stdout: string; stderr: string }
> = {};

mock.module("../../../../util/spawn.js", () => ({
  FFMPEG_TRANSCODE_TIMEOUT_MS: 60_000,
  FFPROBE_TIMEOUT_MS: 10_000,
  spawnWithTimeout: async (args: string[]) => {
    const cmd = args[0];
    if (cmd === "ffprobe" && spawnResults["ffprobe"]) {
      return spawnResults["ffprobe"];
    }
    if (cmd === "ffmpeg" && spawnResults["ffmpeg"]) {
      return spawnResults["ffmpeg"];
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  },
}));

// Mock file access and reading
let accessiblePaths: Set<string> = new Set();
let mockFileContents: Record<string, Buffer> = {};

mock.module("node:fs/promises", () => ({
  access: async (p: string) => {
    if (!accessiblePaths.has(p)) throw new Error(`ENOENT: no such file: ${p}`);
  },
  readFile: async (p: string) => {
    return mockFileContents[p] ?? Buffer.alloc(0);
  },
  unlink: async () => {},
  mkdir: async () => {},
  readdir: async (dir: string) => {
    // Return chunk files if any were set up
    const chunks = Object.keys(mockFileContents).filter(
      (k) => k.startsWith(dir) && k.includes("chunk-"),
    );
    return chunks.map((k) => k.split("/").pop()!);
  },
}));

mock.module("../../../../util/silently.js", () => ({
  silentlyWithLog: async () => {},
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------

import { run } from "./transcribe-media.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conv",
    trustClass: "guardian",
    ...overrides,
  };
}

function makeMockTranscriber(
  results: Array<{ text: string }>,
): BatchTranscriber {
  let callIndex = 0;
  return {
    providerId: "openai-whisper",
    boundaryId: "daemon-batch",
    transcribe: async () => {
      const result = results[callIndex] ?? { text: "" };
      callIndex++;
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("transcribe_media tool", () => {
  beforeEach(() => {
    mockTranscriber = null;
    spawnResults = {};
    accessiblePaths = new Set();
    mockFileContents = {};
  });

  describe("no provider configured", () => {
    test("returns error when no STT provider is available", async () => {
      mockTranscriber = null;

      const result = await run({ file_path: "/tmp/test.mp3" }, makeContext());

      expect(result.isError).toBe(true);
      expect(result.content).toContain(
        "No speech-to-text provider is configured",
      );
    });
  });

  describe("input validation", () => {
    test("returns error when file_path is missing", async () => {
      mockTranscriber = makeMockTranscriber([{ text: "hello" }]);

      const result = await run({}, makeContext());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Provide a file_path");
    });

    test("returns error when file does not exist", async () => {
      mockTranscriber = makeMockTranscriber([{ text: "hello" }]);

      const result = await run(
        { file_path: "/tmp/nonexistent.mp3" },
        makeContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("File not found");
    });

    test("returns error for unsupported file type", async () => {
      mockTranscriber = makeMockTranscriber([{ text: "hello" }]);
      accessiblePaths.add("/tmp/test.xyz");

      const result = await run({ file_path: "/tmp/test.xyz" }, makeContext());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unsupported file type");
    });
  });

  describe("successful transcription", () => {
    test("transcribes audio file via configured STT provider", async () => {
      mockTranscriber = makeMockTranscriber([
        { text: "Hello world, this is a test." },
      ]);
      accessiblePaths.add("/tmp/test.mp3");

      // Mock ffmpeg conversion success — toWav will produce a tmp wav file
      spawnResults["ffmpeg"] = {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
      // Mock ffprobe for duration check
      spawnResults["ffprobe"] = {
        exitCode: 0,
        stdout: "60.0\n",
        stderr: "",
      };

      const result = await run({ file_path: "/tmp/test.mp3" }, makeContext());

      expect(result.isError).toBe(false);
      expect(result.content).toBe("Hello world, this is a test.");
    });

    test("returns no-speech message when transcription is empty", async () => {
      mockTranscriber = makeMockTranscriber([{ text: "" }]);
      accessiblePaths.add("/tmp/silence.wav");

      spawnResults["ffmpeg"] = { exitCode: 0, stdout: "", stderr: "" };
      spawnResults["ffprobe"] = {
        exitCode: 0,
        stdout: "10.0\n",
        stderr: "",
      };

      const result = await run(
        { file_path: "/tmp/silence.wav" },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("No speech detected");
    });
  });

  describe("error handling", () => {
    test("returns error when ffmpeg conversion fails", async () => {
      mockTranscriber = makeMockTranscriber([{ text: "hello" }]);
      accessiblePaths.add("/tmp/test.mp3");

      spawnResults["ffmpeg"] = {
        exitCode: 1,
        stdout: "",
        stderr: "ffmpeg error: unsupported codec",
      };

      const result = await run({ file_path: "/tmp/test.mp3" }, makeContext());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Transcription failed");
      expect(result.content).toContain("ffmpeg failed");
    });
  });

  describe("mode parameter removed", () => {
    test("does not require or use a mode parameter", async () => {
      mockTranscriber = makeMockTranscriber([{ text: "transcribed text" }]);
      accessiblePaths.add("/tmp/test.wav");

      spawnResults["ffmpeg"] = { exitCode: 0, stdout: "", stderr: "" };
      spawnResults["ffprobe"] = {
        exitCode: 0,
        stdout: "30.0\n",
        stderr: "",
      };

      // Passing mode should not affect behavior — it's ignored
      const result = await run(
        { file_path: "/tmp/test.wav", mode: "local" },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toBe("transcribed text");
    });
  });
});
