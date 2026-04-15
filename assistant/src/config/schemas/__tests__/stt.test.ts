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
});
