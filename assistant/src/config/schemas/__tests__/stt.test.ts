import { describe, expect, test } from "bun:test";

import {
  effectiveSttProvider,
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

describe("managed mode", () => {
  test("accepts mode: managed with a BYOK provider preserved", () => {
    const parsed = SttServiceSchema.parse({
      mode: "managed",
      provider: "deepgram",
    });
    expect(parsed.mode).toBe("managed");
    expect(parsed.provider).toBe("deepgram");
  });

  test("accepts provider vellum under managed mode", () => {
    const parsed = SttServiceSchema.parse({
      mode: "managed",
      provider: "vellum",
    });
    expect(parsed.provider).toBe("vellum");
  });

  test("accepts provider vellum regardless of mode", () => {
    const result = SttServiceSchema.safeParse({
      mode: "your-own",
      provider: "vellum",
    });
    expect(result.success).toBe(true);
  });

  test("effectiveSttProvider routes provider vellum and managed mode to vellum, preserves BYOK otherwise", () => {
    expect(
      effectiveSttProvider({ mode: "your-own", provider: "vellum" }),
    ).toBe("vellum");
    expect(
      effectiveSttProvider({ mode: "managed", provider: "deepgram" }),
    ).toBe("vellum");
    expect(
      effectiveSttProvider({ mode: "your-own", provider: "deepgram" }),
    ).toBe("deepgram");
  });
});
