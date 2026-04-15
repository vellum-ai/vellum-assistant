import { describe, expect, test } from "bun:test";

import {
  DeepgramProviderConfigSchema,
  SttProvidersSchema,
  SttServiceSchema,
  VALID_STT_PROVIDERS,
} from "../stt.js";

describe("DeepgramProviderConfigSchema", () => {
  test("empty object parses to documented defaults (diarize: false)", () => {
    const parsed = DeepgramProviderConfigSchema.parse({});
    expect(parsed).toEqual({ diarize: false });
  });

  test("diarize: true round-trips", () => {
    const parsed = DeepgramProviderConfigSchema.parse({ diarize: true });
    expect(parsed).toEqual({ diarize: true });
  });

  test("diarize: false is accepted explicitly", () => {
    const parsed = DeepgramProviderConfigSchema.parse({ diarize: false });
    expect(parsed).toEqual({ diarize: false });
  });

  test("rejects non-boolean diarize values", () => {
    const stringResult = DeepgramProviderConfigSchema.safeParse({
      diarize: "true",
    });
    expect(stringResult.success).toBe(false);

    const numberResult = DeepgramProviderConfigSchema.safeParse({
      diarize: 1,
    });
    expect(numberResult.success).toBe(false);

    const nullResult = DeepgramProviderConfigSchema.safeParse({
      diarize: null,
    });
    expect(nullResult.success).toBe(false);
  });
});

describe("SttProvidersSchema", () => {
  test("accepts a Deepgram entry with diarize set via the dedicated schema", () => {
    const deepgramCfg = DeepgramProviderConfigSchema.parse({ diarize: true });
    const parsed = SttProvidersSchema.parse({ deepgram: deepgramCfg });
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
  test("stt.provider=deepgram with providers.deepgram.diarize round-trips", () => {
    const parsed = SttServiceSchema.parse({
      provider: "deepgram",
      providers: { deepgram: { diarize: true } },
    });
    expect(parsed.provider).toBe("deepgram");
    expect(parsed.providers.deepgram).toEqual({ diarize: true });
  });

  test("VALID_STT_PROVIDERS includes deepgram so the diarize option has a home", () => {
    expect(VALID_STT_PROVIDERS).toContain("deepgram");
  });
});
