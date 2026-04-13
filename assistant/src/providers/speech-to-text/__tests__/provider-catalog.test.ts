import { describe, expect, test } from "bun:test";

import {
  getCredentialProvider,
  getProviderEntry,
  listCredentialProviderNames,
  listProviderEntries,
  listProviderIds,
  supportsBoundary,
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

  test("supportsBoundary returns false for unknown provider IDs", () => {
    // Cast to bypass type checking for the test
    expect(supportsBoundary("nonexistent" as never, "daemon-batch")).toBe(
      false,
    );
  });

  // -----------------------------------------------------------------------
  // Credential lookup
  // -----------------------------------------------------------------------

  test("getCredentialProvider returns correct mapping", () => {
    expect(getCredentialProvider("openai-whisper")).toBe("openai");
    expect(getCredentialProvider("deepgram")).toBe("deepgram");
    expect(getCredentialProvider("google-gemini")).toBe("gemini");
  });

  test("getCredentialProvider returns undefined for unknown ID", () => {
    expect(getCredentialProvider("nonexistent" as never)).toBeUndefined();
  });
});
