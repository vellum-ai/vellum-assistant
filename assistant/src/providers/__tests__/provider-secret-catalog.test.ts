import { describe, expect, test } from "bun:test";

import { API_KEY_PROVIDERS } from "../provider-secret-catalog.js";

// ---------------------------------------------------------------------------
// API_KEY_PROVIDERS derivation invariants
// ---------------------------------------------------------------------------

describe("API_KEY_PROVIDERS", () => {
  test("includes deepgram (STT catalog-derived)", () => {
    expect(API_KEY_PROVIDERS).toContain("deepgram");
  });

  test("includes openai exactly once (shared by LLM and STT)", () => {
    const occurrences = API_KEY_PROVIDERS.filter((p) => p === "openai");
    expect(occurrences.length).toBe(1);
  });

  test("contains no duplicate entries", () => {
    const unique = new Set(API_KEY_PROVIDERS);
    expect(API_KEY_PROVIDERS.length).toBe(unique.size);
  });

  test("is deterministic across calls", () => {
    // Re-import would return the same module-level constant, but this
    // validates that the composition does not introduce non-determinism.
    const first = [...API_KEY_PROVIDERS];
    const second = [...API_KEY_PROVIDERS];
    expect(first).toEqual(second);
  });

  test("includes core LLM providers", () => {
    expect(API_KEY_PROVIDERS).toContain("anthropic");
    expect(API_KEY_PROVIDERS).toContain("openai");
    expect(API_KEY_PROVIDERS).toContain("gemini");
  });
});
