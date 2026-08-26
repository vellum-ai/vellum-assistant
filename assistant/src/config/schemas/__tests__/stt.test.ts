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

  test("language defaults to multilingual rather than staying absent", () => {
    // Every config carries a real language, so nothing downstream has to
    // infer one from an absent key. Omitting the param entirely is not a
    // neutral state on Deepgram and the managed relay: it decodes as
    // English, which is what this default exists to stop.
    const parsed = SttServiceSchema.parse({ provider: "vellum" });
    expect(parsed.language).toBe("multi");
  });

  test("a chosen language is never replaced by the default", () => {
    expect(
      SttServiceSchema.parse({ provider: "deepgram", language: "ta" }).language,
    ).toBe("ta");
    expect(
      SttServiceSchema.parse({ provider: "deepgram", language: "en" }).language,
    ).toBe("en");
  });

  test("language round-trips a code and the multi code-switching mode", () => {
    expect(
      SttServiceSchema.parse({ provider: "vellum", language: "multi" })
        .language,
    ).toBe("multi");
    expect(
      SttServiceSchema.parse({ provider: "deepgram", language: "hi" }).language,
    ).toBe("hi");
  });

  test("language is trimmed and rejects blank strings", () => {
    expect(
      SttServiceSchema.parse({ provider: "vellum", language: "  multi  " })
        .language,
    ).toBe("multi");
    expect(() =>
      SttServiceSchema.parse({ provider: "vellum", language: "   " }),
    ).toThrow(/must not be empty/);
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
    expect(parsed).toEqual({
      provider: "vellum",
      language: "multi",
      providers: {},
      roles: {},
    });
  });
});

describe("services.stt.roles", () => {
  test("defaults to empty so an untouched config is unchanged", () => {
    expect(SttServiceSchema.parse({ provider: "deepgram" }).roles).toEqual({});
  });

  test("accepts a role whose selection covers what it needs", () => {
    const parsed = SttServiceSchema.parse({
      provider: "deepgram",
      roles: { liveVoice: { provider: "deepgram", model: "flux" } },
    });
    expect(parsed.roles).toEqual({
      liveVoice: { provider: "deepgram", model: "flux" },
    });
  });

  test("a role can select a different family than the global default", () => {
    // The point of the split: live voice on flux while everything else keeps
    // the batch-capable family.
    const parsed = SttServiceSchema.parse({
      provider: "deepgram",
      roles: { liveVoice: { provider: "deepgram", model: "flux" } },
    });
    expect(parsed.provider).toBe("deepgram");
    expect(parsed.roles.liveVoice?.model).toBe("flux");
  });

  test("rejects a streaming-only family for a role that batches", () => {
    // The whole point of the split: Flux has no batch endpoint, so it can
    // serve live voice and cannot serve file transcription.
    for (const role of ["batch", "dictation", "telephony"]) {
      const result = SttServiceSchema.safeParse({
        provider: "deepgram",
        roles: { [role]: { provider: "deepgram", model: "flux" } },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain(
        `services.stt.roles.${role} cannot be "deepgram" running flux`,
      );
    }
  });

  test("names the first requirement a provider misses", () => {
    // Telephony needs both boundaries AND call ingestion. Flux is missing a
    // boundary, so that is what the message says: the reported reason is the
    // one the user has to act on, not a generic incompatibility.
    const result = SttServiceSchema.safeParse({
      provider: "deepgram",
      roles: { telephony: { provider: "deepgram", model: "flux" } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "supports no daemon-batch transcription, which telephony needs",
    );
  });

  test("rejects an unknown role key", () => {
    expect(
      SttServiceSchema.safeParse({
        provider: "deepgram",
        roles: { transcription: { provider: "deepgram" } },
      }).success,
    ).toBe(false);
  });

  test("normalizes provider aliases inside a role", () => {
    expect(
      SttServiceSchema.parse({
        provider: "deepgram",
        roles: { batch: { provider: "whisper" } },
      }).roles,
    ).toEqual({ batch: { provider: "openai-whisper" } });
  });
});

describe("services.stt.roles model validation", () => {
  test("rejects a family the role's provider cannot serve", () => {
    const result = SttServiceSchema.safeParse({
      provider: "deepgram",
      roles: { liveVoice: { provider: "openai-whisper", model: "flux" } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("single model");
  });

  test("a role with no model runs the provider's default family", () => {
    const parsed = SttServiceSchema.parse({
      provider: "deepgram",
      roles: { batch: { provider: "deepgram" } },
    });
    expect(parsed.roles.batch).toEqual({ provider: "deepgram" });
  });
});
