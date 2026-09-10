import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BatchTranscriber } from "../../../../stt/types.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the subject import
// ---------------------------------------------------------------------------

let mockTranscriber: BatchTranscriber | null = null;

mock.module("../../../../providers/speech-to-text/resolve.js", () => ({
  resolveBatchTranscriber: async () => mockTranscriber,
}));

let spawnResult: { exitCode: number; stdout: string; stderr: string } = {
  exitCode: 0,
  stdout: "",
  stderr: "",
};

let spawnSignals: (AbortSignal | undefined)[] = [];

mock.module("../../../../util/spawn.js", () => ({
  spawnWithTimeout: async (
    _cmd: string[],
    _timeoutMs: number,
    signal?: AbortSignal,
  ) => {
    spawnSignals.push(signal);
    signal?.throwIfAborted();
    return spawnResult;
  },
}));

let mockFileContents: Buffer = Buffer.alloc(0);

mock.module("node:fs/promises", () => ({
  readFile: async () => mockFileContents,
  unlink: async () => {},
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------

import { createAbortReason } from "../../../../util/abort-reasons.js";
import { transcribeSegmentAudio } from "../services/audio-transcribe.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockTranscriber(text: string): BatchTranscriber {
  return {
    providerId: "openai-whisper",
    boundaryId: "daemon-batch",
    transcribe: async () => ({ text }),
  };
}

function makeFailingTranscriber(error: Error): BatchTranscriber {
  return {
    providerId: "openai-whisper",
    boundaryId: "daemon-batch",
    transcribe: async () => {
      throw error;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("transcribeSegmentAudio", () => {
  beforeEach(() => {
    mockTranscriber = null;
    spawnResult = { exitCode: 0, stdout: "", stderr: "" };
    mockFileContents = Buffer.from("fake-wav-data");
  });

  test("returns transcript text on successful transcription", async () => {
    mockTranscriber = makeMockTranscriber("Hello, this is a test transcript.");

    const result = await transcribeSegmentAudio("/tmp/video.mp4", 10, 15);

    expect(result).toBe("Hello, this is a test transcript.");
  });

  test("returns empty string when no STT provider is configured", async () => {
    mockTranscriber = null;

    const result = await transcribeSegmentAudio("/tmp/video.mp4", 0, 30);

    expect(result).toBe("");
  });

  test("returns empty string when ffmpeg extraction fails", async () => {
    mockTranscriber = makeMockTranscriber("should not reach here");
    spawnResult = {
      exitCode: 1,
      stdout: "",
      stderr: "ffmpeg: error extracting audio",
    };

    const result = await transcribeSegmentAudio("/tmp/video.mp4", 5, 10);

    expect(result).toBe("");
  });

  test("returns empty string when provider throws an error", async () => {
    mockTranscriber = makeFailingTranscriber(
      new Error("Provider API rate limited"),
    );

    const result = await transcribeSegmentAudio("/tmp/video.mp4", 0, 20);

    expect(result).toBe("");
  });

  test("trims whitespace from transcript result", async () => {
    mockTranscriber = makeMockTranscriber("  trimmed text  ");

    const result = await transcribeSegmentAudio("/tmp/video.mp4", 0, 10);

    expect(result).toBe("trimmed text");
  });

  test("returns empty string when provider returns empty text", async () => {
    mockTranscriber = makeMockTranscriber("");

    const result = await transcribeSegmentAudio("/tmp/video.mp4", 0, 10);

    expect(result).toBe("");
  });
});

describe("transcribeSegmentAudio cancellation", () => {
  const REASON = createAbortReason("user_cancel", "audio-transcribe.test");

  test("the ffmpeg extraction is handed the signal", async () => {
    spawnSignals = [];
    const controller = new AbortController();
    mockTranscriber = makeMockTranscriber("hello");
    spawnResult = { exitCode: 0, stdout: "", stderr: "" };

    await transcribeSegmentAudio(
      "/tmp/v.mp4",
      0,
      5,
      mockTranscriber,
      controller.signal,
    );
    expect(spawnSignals[0]).toBe(controller.signal);
  });

  test("the transcribe request runs under the turn signal too", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    mockTranscriber = {
      ...makeMockTranscriber("hello"),
      transcribe: async (req: { signal?: AbortSignal }) => {
        seen = req.signal;
        return { text: "hello" };
      },
    } as unknown as BatchTranscriber;
    spawnResult = { exitCode: 0, stdout: "", stderr: "" };

    await transcribeSegmentAudio(
      "/tmp/v.mp4",
      0,
      5,
      mockTranscriber,
      controller.signal,
    );
    // Composed with the request's own timeout, so it is not the raw signal.
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
    controller.abort(REASON);
    expect(seen!.aborted).toBe(true);
  });

  /**
   * Every other failure degrades to an empty transcript so one bad segment
   * cannot kill the run. A cancellation must not: the caller has to stop
   * rather than record a silent segment and move to the next one.
   */
  test("a cancelled turn raises instead of degrading to no transcript", async () => {
    const controller = new AbortController();
    controller.abort(REASON);
    mockTranscriber = makeMockTranscriber("hello");

    await expect(
      transcribeSegmentAudio(
        "/tmp/v.mp4",
        0,
        5,
        mockTranscriber,
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
