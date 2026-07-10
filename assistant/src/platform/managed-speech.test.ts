import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface MockPlatformClient {
  platformAssistantId: string;
  fetch: ReturnType<typeof mock>;
}

let mockClient: MockPlatformClient | null = null;

mock.module("./client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockClient,
  },
}));

import {
  managedSpeechSynthesize,
  managedSpeechTranscribe,
} from "./managed-speech.js";

const AUDIO = Buffer.from([0x01, 0x02, 0x03, 0xff]);

describe("managedSpeechTranscribe", () => {
  beforeEach(() => {
    mockClient = {
      platformAssistantId: "asst-123",
      fetch: mock(
        async () =>
          new Response(
            JSON.stringify({
              text: "hello world",
              providerId: "deepgram",
              model: "nova-3",
              durationSeconds: 12.5,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    };
  });

  afterEach(() => {
    mockClient = null;
  });

  test("posts base64 audio to the assistant's transcribe endpoint", async () => {
    const result = await managedSpeechTranscribe({
      audio: AUDIO,
      mimeType: "audio/wav",
      source: "dictation",
    });

    expect(result).toEqual({
      ok: true,
      value: { text: "hello world", durationSeconds: 12.5 },
    });
    const [path, init] = mockClient!.fetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(path).toBe("/v1/assistants/asst-123/managed-speech/stt/transcribe/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      audioBase64: AUDIO.toString("base64"),
      mimeType: "audio/wav",
      source: "dictation",
    });
  });

  test("omits source when not provided", async () => {
    await managedSpeechTranscribe({ audio: AUDIO, mimeType: "audio/wav" });
    const [, init] = mockClient!.fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("source");
  });

  test("returns unavailable when no platform client resolves", async () => {
    mockClient = null;
    const result = await managedSpeechTranscribe({
      audio: AUDIO,
      mimeType: "audio/wav",
    });
    expect(result).toMatchObject({ ok: false, kind: "unavailable" });
  });

  test("returns unavailable when the assistant ID is missing", async () => {
    mockClient!.platformAssistantId = "";
    const result = await managedSpeechTranscribe({
      audio: AUDIO,
      mimeType: "audio/wav",
    });
    expect(result).toMatchObject({ ok: false, kind: "unavailable" });
  });

  test("surfaces the platform error code on 402", async () => {
    mockClient!.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            code: "insufficient_balance",
            detail: "Insufficient balance. Please add funds to continue.",
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await managedSpeechTranscribe({
      audio: AUDIO,
      mimeType: "audio/wav",
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "platform-error",
      status: 402,
      code: "insufficient_balance",
      message: "Insufficient balance. Please add funds to continue.",
    });
  });

  test("treats a malformed 200 body as a platform error", async () => {
    mockClient!.fetch = mock(
      async () =>
        new Response(JSON.stringify({ unexpected: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await managedSpeechTranscribe({
      audio: AUDIO,
      mimeType: "audio/wav",
    });
    expect(result).toMatchObject({ ok: false, kind: "platform-error" });
  });
});

describe("managedSpeechSynthesize", () => {
  const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]);

  beforeEach(() => {
    mockClient = {
      platformAssistantId: "asst-123",
      fetch: mock(
        async () =>
          new Response(new Uint8Array(MP3_BYTES), {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          }),
      ),
    };
  });

  afterEach(() => {
    mockClient = null;
  });

  test("posts text and format, round-trips binary audio and content type", async () => {
    const result = await managedSpeechSynthesize({
      text: "hello",
      format: "pcm_16000",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Buffer.compare(result.value.audio, MP3_BYTES)).toBe(0);
      expect(result.value.contentType).toBe("audio/mpeg");
    }
    const [path, init] = mockClient!.fetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(path).toBe("/v1/assistants/asst-123/managed-speech/tts/synthesize/");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "hello",
      format: "pcm_16000",
    });
  });

  test("falls back to audio/mpeg when no content type is returned", async () => {
    mockClient!.fetch = mock(
      async () => new Response(new Uint8Array(MP3_BYTES), { status: 200 }),
    );
    const result = await managedSpeechSynthesize({
      text: "hello",
      format: "mp3",
    });
    expect(result.ok && result.value.contentType).toBe("audio/mpeg");
  });

  test("treats empty audio as a platform error", async () => {
    mockClient!.fetch = mock(
      async () => new Response(new Uint8Array(0), { status: 200 }),
    );
    const result = await managedSpeechSynthesize({
      text: "hello",
      format: "mp3",
    });
    expect(result).toMatchObject({ ok: false, kind: "platform-error" });
  });

  test("surfaces insufficient_balance on 402", async () => {
    mockClient!.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({ code: "insufficient_balance", detail: "Top up." }),
          { status: 402, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await managedSpeechSynthesize({
      text: "hello",
      format: "mp3",
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "platform-error",
      status: 402,
      code: "insufficient_balance",
    });
  });
});
