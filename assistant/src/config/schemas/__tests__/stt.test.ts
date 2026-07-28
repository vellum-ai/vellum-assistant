import { describe, expect, test } from "bun:test";

import {
  SttProvidersSchema,
  SttServiceSchema,
  VALID_STT_PROVIDERS,
} from "../stt.js";

describe("SttProvidersSchema", () => {
  test("accepts a Deepgram entry with arbitrary fields (generic record)", () => {
    const parsed = SttProvidersSchema.parse({
      deepgram: { diarize: true },
    });
    expect(parsed).toEqual({ deepgram: { diarize: true } });
  });

  test("forward-compatible: unknown provider keys still pass validation", () => {
    const parsed = SttProvidersSchema.parse({
      "future-provider": { someField: 42 },
    });
    expect(parsed).toEqual({ "future-provider": { someField: 42 } });
  });

  test("empty providers map parses to {}", () => {
    const parsed = SttProvidersSchema.parse({});
    expect(parsed).toEqual({});
  });
});

describe("SttServiceSchema", () => {
  test("stt.provider=deepgram with providers.deepgram round-trips", () => {
    const parsed = SttServiceSchema.parse({
      provider: "deepgram",
      providers: { deepgram: { diarize: true } },
    });
    expect(parsed.provider).toBe("deepgram");
    expect(parsed.providers.deepgram).toEqual({ diarize: true });
  });

  test("VALID_STT_PROVIDERS includes deepgram", () => {
    expect(VALID_STT_PROVIDERS).toContain("deepgram");
  });

  test("normalizes the openai/whisper aliases to openai-whisper", () => {
    expect(SttServiceSchema.parse({ provider: "openai" }).provider).toBe(
      "openai-whisper",
    );
    expect(SttServiceSchema.parse({ provider: "whisper" }).provider).toBe(
      "openai-whisper",
    );
    // Case- and whitespace-tolerant.
    expect(SttServiceSchema.parse({ provider: "  OpenAI  " }).provider).toBe(
      "openai-whisper",
    );
  });

  test("a canonical provider is unchanged by the alias preprocessor", () => {
    expect(
      SttServiceSchema.parse({ provider: "openai-whisper" }).provider,
    ).toBe("openai-whisper");
  });

  test("rejects an unknown provider with a helpful message", () => {
    expect(() => SttServiceSchema.parse({ provider: "nope" })).toThrow(
      /must be one of/,
    );
  });
});

describe("managed provider", () => {
  test("accepts vellum as an ordinary provider choice", () => {
    const parsed = SttServiceSchema.parse({ provider: "vellum" });
    expect(parsed.provider).toBe("vellum");
  });

  // Migration 130 folds mode into provider; a stale key must not resurrect
  // the second axis or fail the parse.
  test("ignores a legacy mode key", () => {
    const parsed = SttServiceSchema.parse({
      mode: "managed",
      provider: "vellum",
    });
    expect(parsed).toEqual({ provider: "vellum", providers: {} });
  });
});
