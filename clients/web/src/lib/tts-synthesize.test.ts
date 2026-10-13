import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { changeLocale, initI18n } from "@/i18n";

import { synthesizeTTS } from "./tts-synthesize";

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await initI18n();
  await changeLocale("en");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("synthesizeTTS fish-audio", () => {
  test("posts to Fish Audio with the model header and voice reference", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    ) as unknown as typeof fetch;

    const result = await synthesizeTTS({
      provider: "fish-audio",
      apiKey: "test-key",
      voiceId: " voice-123 ",
      text: "Hello from the preview.",
    });

    expect(result.kind).toBe("audio");
    if (result.kind === "audio") {
      expect(result.blob.size).toBe(4);
    }
    expect(capturedUrl).toBe("https://api.fish.audio/v1/tts");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-key");
    expect(headers.get("model")).toBe("s2-pro");
    const body = JSON.parse(String(capturedInit?.body)) as {
      reference_id?: string;
      format?: string;
      model?: string;
    };
    expect(body.reference_id).toBe("voice-123");
    expect(body.format).toBe("mp3");
    expect(body.model).toBeUndefined();
  });

  test("asks for a voice id before calling Fish Audio", async () => {
    const fetchMock = mock(async () => new Response());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await synthesizeTTS({
      provider: "fish-audio",
      apiKey: "test-key",
      voiceId: "   ",
      text: "Hello",
    });

    expect(result).toEqual({
      kind: "error",
      message: "Enter a Voice ID before testing Fish Audio.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("surfaces a Fish Audio error message", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ message: "Invalid reference id" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await synthesizeTTS({
      provider: "fish-audio",
      apiKey: "test-key",
      voiceId: "voice-123",
      text: "Hello",
    });

    expect(result).toEqual({
      kind: "error",
      message: "Invalid reference id",
    });
  });
});

describe("synthesizeTTS xai", () => {
  test("does not claim the preview only works in the desktop app", async () => {
    const result = await synthesizeTTS({
      provider: "xai",
      apiKey: "test-key",
      voiceId: "",
      text: "Hello",
    });

    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.message).not.toMatch(/desktop app/i);
      expect(result.message).toContain("ElevenLabs or Deepgram");
    }
  });
});
