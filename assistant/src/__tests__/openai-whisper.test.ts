import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { OpenAIWhisperProvider } from "../providers/speech-to-text/openai-whisper.js";

// ---------------------------------------------------------------------------
// Mock fetch — capture outgoing FormData so we can assert filenames
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

let capturedFormData: FormData | null = null;

function mockFetch(
  _url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (init?.body instanceof FormData) {
    capturedFormData = init.body;
  }
  return Promise.resolve(
    new Response(JSON.stringify({ text: "hello world" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  capturedFormData = null;
  globalThis.fetch = mockFetch as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAIWhisperProvider", () => {
  const provider = new OpenAIWhisperProvider("test-api-key");
  const dummyAudio = Buffer.from("fake-audio-data");

  describe("extensionFromMime (via transcribe filename)", () => {
    test("plain MIME type resolves to correct extension", async () => {
      await provider.transcribe(dummyAudio, "audio/ogg");
      const file = capturedFormData?.get("file") as File;
      expect(file.name).toBe("audio.ogg");
    });

    test("MIME type with parameters resolves to correct extension", async () => {
      await provider.transcribe(dummyAudio, "audio/ogg; codecs=opus");
      const file = capturedFormData?.get("file") as File;
      expect(file.name).toBe("audio.ogg");
    });

    test("MIME type with extra whitespace around parameters", async () => {
      await provider.transcribe(dummyAudio, "audio/mpeg ; bitrate=128");
      const file = capturedFormData?.get("file") as File;
      expect(file.name).toBe("audio.mp3");
    });

    test("unknown MIME type falls back to .audio", async () => {
      await provider.transcribe(dummyAudio, "audio/unknown-format");
      const file = capturedFormData?.get("file") as File;
      expect(file.name).toBe("audio.audio");
    });

    test("unknown MIME type with parameters still falls back", async () => {
      await provider.transcribe(dummyAudio, "audio/unknown; foo=bar");
      const file = capturedFormData?.get("file") as File;
      expect(file.name).toBe("audio.audio");
    });

    test.each([
      ["audio/wav", "audio.wav"],
      ["audio/x-wav", "audio.wav"],
      ["audio/mpeg", "audio.mp3"],
      ["audio/mp3", "audio.mp3"],
      ["audio/ogg", "audio.ogg"],
      ["audio/opus", "audio.opus"],
      ["audio/webm", "audio.webm"],
      ["audio/mp4", "audio.m4a"],
      ["audio/x-m4a", "audio.m4a"],
      ["audio/flac", "audio.flac"],
    ])("%s → %s", async (mime, expectedFilename) => {
      await provider.transcribe(dummyAudio, mime);
      const file = capturedFormData?.get("file") as File;
      expect(file.name).toBe(expectedFilename);
    });
  });
});
