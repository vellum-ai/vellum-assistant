import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must appear before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => "test-fish-api-key",
}));

mock.module("../../security/credential-key.js", () => ({
  credentialKey: (service: string, field: string) =>
    `credential/${service}/${field}`,
}));

import type { FishAudioConfig } from "../../config/schemas/fish-audio.js";
import { synthesizeWithFishAudio } from "../fish-audio-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const config: FishAudioConfig = {
  referenceId: "test-reference-id",
  chunkLength: 200,
  format: "wav",
  latency: "normal",
  speed: 1.0,
};

let originalFetch: typeof globalThis.fetch;
let capturedBody = "";

beforeEach(() => {
  originalFetch = globalThis.fetch;
  capturedBody = "";
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = init?.body as string;
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("synthesizeWithFishAudio request body", () => {
  test("includes sample_rate when the sampleRate option is set", async () => {
    await synthesizeWithFishAudio("hello", config, { sampleRate: 8000 });

    const body = JSON.parse(capturedBody);
    expect(body.sample_rate).toBe(8000);
    expect(body.format).toBe("wav");
  });

  test("omits sample_rate when the option is not set", async () => {
    await synthesizeWithFishAudio("hello", config);

    const body = JSON.parse(capturedBody);
    expect("sample_rate" in body).toBe(false);
  });

  test("passes pcm format and sample_rate through to the request body", async () => {
    await synthesizeWithFishAudio(
      "hello",
      { ...config, format: "pcm" },
      { sampleRate: 24000 },
    );

    const body = JSON.parse(capturedBody);
    expect(body.format).toBe("pcm");
    expect(body.sample_rate).toBe(24000);
  });
});
