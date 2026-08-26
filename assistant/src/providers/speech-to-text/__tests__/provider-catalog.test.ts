import { describe, expect, test } from "bun:test";

import {
  baseModelFamilyFor,
  batchBoundaryGapReason,
  getCredentialProvider,
  getProviderEntry,
  listCredentialProviderNames,
  listProviderEntries,
  listProviderIds,
  listProviderModelFamilies,
  listSelectableProviderIds,
  resolveSttCatalogKey,
  sttConfigForCatalogKey,
  supportsBoundary,
  supportsDiarization,
  supportsProviderTurnDetection,
} from "../provider-catalog.js";

// ---------------------------------------------------------------------------
// Catalog invariants
// ---------------------------------------------------------------------------

describe("STT provider catalog", () => {
  // -----------------------------------------------------------------------
  // Stable IDs
  // -----------------------------------------------------------------------

  test("listProviderIds returns all known provider IDs", () => {
    const ids = listProviderIds();
    expect(ids).toContain("openai-whisper");
    expect(ids).toContain("deepgram");
    expect(ids).toContain("deepgram-flux");
    expect(ids).toContain("google-gemini");
  });

  test("listProviderIds returns IDs in deterministic insertion order", () => {
    const first = listProviderIds();
    const second = listProviderIds();
    expect(first).toEqual(second);
  });

  test("every ID returned by listProviderIds has a catalog entry", () => {
    for (const id of listProviderIds()) {
      expect(getProviderEntry(id)).toBeDefined();
    }
  });

  // -----------------------------------------------------------------------
  // Credential provider names
  // -----------------------------------------------------------------------

  test("listCredentialProviderNames returns deduplicated names", () => {
    const names = listCredentialProviderNames();
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });

  test("listCredentialProviderNames includes expected providers", () => {
    const names = listCredentialProviderNames();
    // openai-whisper maps to "openai", deepgram maps to "deepgram", google-gemini maps to "gemini"
    expect(names).toContain("openai");
    expect(names).toContain("deepgram");
    expect(names).toContain("gemini");
  });

  test("listCredentialProviderNames returns names in deterministic order", () => {
    const first = listCredentialProviderNames();
    const second = listCredentialProviderNames();
    expect(first).toEqual(second);
  });

  // -----------------------------------------------------------------------
  // Entry-level invariants
  // -----------------------------------------------------------------------

  test("every entry has a non-empty credentialProvider", () => {
    for (const entry of listProviderEntries()) {
      expect(entry.credentialProvider.length).toBeGreaterThan(0);
    }
  });

  test("every entry has at least one supported boundary", () => {
    for (const entry of listProviderEntries()) {
      expect(entry.supportedBoundaries.size).toBeGreaterThan(0);
    }
  });

  test("every entry ID matches its catalog key", () => {
    for (const id of listProviderIds()) {
      const entry = getProviderEntry(id);
      expect(entry?.id).toBe(id);
    }
  });

  // -----------------------------------------------------------------------
  // Boundary support
  // -----------------------------------------------------------------------

  test("supportsBoundary returns true for supported boundaries", () => {
    expect(supportsBoundary("openai-whisper", "daemon-batch")).toBe(true);
    expect(supportsBoundary("deepgram", "daemon-batch")).toBe(true);
    expect(supportsBoundary("google-gemini", "daemon-batch")).toBe(true);
  });

  test("supportsBoundary returns true for daemon-streaming on streaming-capable providers", () => {
    expect(supportsBoundary("deepgram", "daemon-streaming")).toBe(true);
    expect(supportsBoundary("google-gemini", "daemon-streaming")).toBe(true);
    expect(supportsBoundary("openai-whisper", "daemon-streaming")).toBe(true);
  });

  test("deepgram-flux is streaming-only", () => {
    // Flux has no batch endpoint; the batch transcriber factory rejects it
    // explicitly rather than silently falling through.
    expect(supportsBoundary("deepgram-flux", "daemon-streaming")).toBe(true);
    expect(supportsBoundary("deepgram-flux", "daemon-batch")).toBe(false);
  });

  test("batchBoundaryGapReason names the batch provider on the same credential", () => {
    const reason = batchBoundaryGapReason("deepgram-flux");
    expect(reason).toBe(
      'Deepgram Flux is streaming-only. Batch transcription requires the deepgram provider: set services.stt.provider to "deepgram".',
    );
  });

  test("batchBoundaryGapReason falls back to generic guidance for an unknown provider", () => {
    // No catalog entry means no credential to search a batch-capable peer on.
    const reason = batchBoundaryGapReason("nonexistent" as never);
    expect(reason).toContain("nonexistent is streaming-only");
    expect(reason).toContain("supports batch transcription");
  });

  test("supportsBoundary returns false for unknown provider IDs", () => {
    // Cast to bypass type checking for the test
    expect(supportsBoundary("nonexistent" as never, "daemon-batch")).toBe(
      false,
    );
  });

  // -----------------------------------------------------------------------
  // Conversation streaming mode
  // -----------------------------------------------------------------------

  test("conversationStreamingMode is set for all providers", () => {
    for (const entry of listProviderEntries()) {
      expect(entry.conversationStreamingMode).toBeDefined();
      expect(["realtime-ws", "incremental-batch", "none"]).toContain(
        entry.conversationStreamingMode,
      );
    }
  });

  test("deepgram has realtime-ws conversation streaming mode", () => {
    const entry = getProviderEntry("deepgram");
    expect(entry?.conversationStreamingMode).toBe("realtime-ws");
  });

  test("google-gemini has realtime-ws conversation streaming mode", () => {
    const entry = getProviderEntry("google-gemini");
    expect(entry?.conversationStreamingMode).toBe("realtime-ws");
  });

  test("openai-whisper has incremental-batch conversation streaming mode", () => {
    const entry = getProviderEntry("openai-whisper");
    expect(entry?.conversationStreamingMode).toBe("incremental-batch");
  });

  // -----------------------------------------------------------------------
  // Language selection capability
  // -----------------------------------------------------------------------

  test("languageSelection is set for all providers", () => {
    for (const entry of listProviderEntries()) {
      expect(["manual", "auto"]).toContain(entry.languageSelection);
    }
  });

  const expectedLanguageSelection = [
    ["deepgram", "manual"],
    ["vellum", "manual"],
    ["xai", "manual"],
    // Flux takes no language parameter: its model is monolingual English.
    ["deepgram-flux", "auto"],
    ["google-gemini", "auto"],
    ["openai-whisper", "auto"],
  ] as const;

  test.each(expectedLanguageSelection)(
    "%s has languageSelection %s",
    (id, expected) => {
      expect(getProviderEntry(id)?.languageSelection).toBe(expected);
    },
  );

  // -----------------------------------------------------------------------
  // Credential lookup
  // -----------------------------------------------------------------------

  test("getCredentialProvider returns correct mapping", () => {
    expect(getCredentialProvider("openai-whisper")).toBe("openai");
    expect(getCredentialProvider("deepgram")).toBe("deepgram");
    expect(getCredentialProvider("google-gemini")).toBe("gemini");
  });

  test("deepgram-flux shares the deepgram credential", () => {
    expect(getCredentialProvider("deepgram-flux")).toBe("deepgram");
    // Sharing must not duplicate the key in the API-key provider list.
    const deepgramEntries = listCredentialProviderNames().filter(
      (name) => name === "deepgram",
    );
    expect(deepgramEntries).toEqual(["deepgram"]);
  });

  test("getCredentialProvider returns undefined for unknown ID", () => {
    expect(getCredentialProvider("nonexistent" as never)).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Speaker diarization capability
  // -----------------------------------------------------------------------

  test("supportsDiarization is set as a boolean for every entry", () => {
    for (const entry of listProviderEntries()) {
      expect(typeof entry.supportsDiarization).toBe("boolean");
    }
  });

  test("deepgram supportsDiarization is true", () => {
    const entry = getProviderEntry("deepgram");
    expect(entry?.supportsDiarization).toBe(true);
  });

  test("google-gemini supportsDiarization is false", () => {
    const entry = getProviderEntry("google-gemini");
    expect(entry?.supportsDiarization).toBe(false);
  });

  test("openai-whisper supportsDiarization is false", () => {
    const entry = getProviderEntry("openai-whisper");
    expect(entry?.supportsDiarization).toBe(false);
  });

  test("supportsDiarization helper returns expected booleans per provider", () => {
    expect(supportsDiarization("deepgram")).toBe(true);
    expect(supportsDiarization("google-gemini")).toBe(false);
    expect(supportsDiarization("openai-whisper")).toBe(false);
  });

  test("supportsDiarization helper returns false for unknown provider IDs", () => {
    expect(supportsDiarization("nonexistent" as never)).toBe(false);
  });
});

describe("connection-based providers", () => {
  test("vellum is excluded from the API-key credential provider list", () => {
    expect(listCredentialProviderNames()).not.toContain("vellum");
  });

  test("API-key providers remain listed", () => {
    const names = listCredentialProviderNames();
    for (const expected of ["deepgram", "gemini", "openai", "xai"]) {
      expect(names).toContain(expected);
    }
  });
});

describe("model families", () => {
  test("flux rows are variants, not separately selectable providers", () => {
    // The whole point of folding these back: a model choice must not cost a
    // provider enum entry and a picker row.
    for (const id of ["deepgram-flux", "vellum-flux"] as const) {
      expect(getProviderEntry(id)?.variantOf).toBeDefined();
      expect(listSelectableProviderIds()).not.toContain(id);
    }
    expect(listSelectableProviderIds()).toEqual(
      expect.arrayContaining(["deepgram", "vellum"]),
    );
  });

  test("a provider plus model family resolves to the variant row", () => {
    expect(
      resolveSttCatalogKey({
        provider: "deepgram",
        providers: { deepgram: { model: "flux" } },
      }),
    ).toBe("deepgram-flux");
    expect(
      resolveSttCatalogKey({
        provider: "vellum",
        providers: { vellum: { model: "flux" } },
      }),
    ).toBe("vellum-flux");
  });

  test("no model, or one the provider does not offer, resolves to the base row", () => {
    expect(resolveSttCatalogKey({ provider: "deepgram" })).toBe("deepgram");
    expect(
      resolveSttCatalogKey({
        provider: "deepgram",
        providers: { deepgram: { model: "nova-3" } },
      }),
    ).toBe("deepgram");
    // Inert rather than fatal: a family a provider does not implement falls
    // back instead of resolving nothing.
    expect(
      resolveSttCatalogKey({
        provider: "openai-whisper",
        providers: { "openai-whisper": { model: "flux" } },
      }),
    ).toBe("openai-whisper");
  });

  test("a model set on another provider's entry does not leak", () => {
    expect(
      resolveSttCatalogKey({
        provider: "deepgram",
        providers: { vellum: { model: "flux" } },
      }),
    ).toBe("deepgram");
  });

  test("names the base family so a stale variant model can be overwritten", () => {
    // Substituting away from a variant has to write something: leaving the
    // old model behind resolves straight back to the variant on next load.
    expect(baseModelFamilyFor("vellum")).toBe("nova-3");
    expect(baseModelFamilyFor("deepgram")).toBe("nova-3");
    // Nothing to write, and no variant that could have left a stale value.
    expect(baseModelFamilyFor("openai-whisper")).toBeUndefined();
    expect(baseModelFamilyFor("vellum-flux")).toBeUndefined();
  });

  test("round-trips a resolved key back to the config that selects it", () => {
    // Anything persisting a resolved provider needs this: the key itself is
    // not a valid services.stt.provider value.
    expect(sttConfigForCatalogKey("vellum-flux")).toEqual({
      provider: "vellum",
      model: "flux",
    });
    expect(sttConfigForCatalogKey("deepgram")).toEqual({
      provider: "deepgram",
    });
  });

  test("only providers with variants advertise families", () => {
    expect(listProviderModelFamilies("deepgram")).toEqual(["nova-3", "flux"]);
    expect(listProviderModelFamilies("openai-whisper")).toEqual([]);
    expect(listProviderModelFamilies("deepgram-flux")).toEqual([]);
  });
});

describe("vellum-flux (managed Flux)", () => {
  test("shares the vellum connection rather than a second credential", () => {
    expect(getProviderEntry("vellum-flux")?.credentialProvider).toBe("vellum");
    expect(listCredentialProviderNames()).not.toContain("vellum-flux");
  });

  test("is streaming-only, like the BYOK Flux entry", () => {
    expect(supportsBoundary("vellum-flux", "daemon-streaming")).toBe(true);
    expect(supportsBoundary("vellum-flux", "daemon-batch")).toBe(false);
  });

  test("decides end-of-turn itself, unlike plain vellum", () => {
    // The relay is dialed with contract=flux, so Flux's turn events survive.
    expect(supportsProviderTurnDetection("vellum-flux")).toBe(true);
    expect(supportsProviderTurnDetection("vellum")).toBe(false);
  });

  test("stays off telephony", () => {
    // The relay maps Finalize onto CloseStream and utterance-boundary finals
    // are a nova-3 concept, so calls stay on `vellum`.
    expect(getProviderEntry("vellum-flux")?.telephonyMode).toBe("none");
  });

  test("exposes a language picker, unlike BYOK Flux", () => {
    // The relay picks flux-general-en or flux-general-multi from the language
    // it is sent, so the selection is meaningful here.
    expect(getProviderEntry("vellum-flux")?.languageSelection).toBe("manual");
  });
});
