import { describe, expect, test } from "bun:test";

import {
  getCatalogProvider,
  listCatalogProviderIds,
  listCatalogProviders,
} from "../provider-catalog.js";

// ---------------------------------------------------------------------------
// Catalog invariants
// ---------------------------------------------------------------------------

describe("TTS provider catalog", () => {
  const entries = listCatalogProviders();
  const ids = listCatalogProviderIds();

  // -- Uniqueness -----------------------------------------------------------

  test("all provider IDs are unique", () => {
    const seen = new Set<string>();
    for (const entry of entries) {
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);
    }
  });

  // -- Required fields ------------------------------------------------------

  test("every entry has a non-empty id", () => {
    for (const entry of entries) {
      expect(entry.id.length).toBeGreaterThan(0);
    }
  });

  test("every entry has a non-empty displayName", () => {
    for (const entry of entries) {
      expect(entry.displayName.length).toBeGreaterThan(0);
    }
  });

  test("every entry has a valid callMode", () => {
    const validModes = new Set(["native-twilio", "synthesized-play"]);
    for (const entry of entries) {
      expect(validModes.has(entry.callMode)).toBe(true);
    }
  });

  test("every entry has a capabilities object with supportedFormats", () => {
    for (const entry of entries) {
      expect(entry.capabilities).toBeDefined();
      expect(Array.isArray(entry.capabilities.supportedFormats)).toBe(true);
      expect(entry.capabilities.supportedFormats.length).toBeGreaterThan(0);
    }
  });

  test("every entry has at least one secret requirement", () => {
    for (const entry of entries) {
      expect(entry.secretRequirements.length).toBeGreaterThan(0);
    }
  });

  test("every secret requirement has non-empty fields", () => {
    for (const entry of entries) {
      for (const secret of entry.secretRequirements) {
        expect(secret.credentialStoreKey.length).toBeGreaterThan(0);
        expect(secret.displayName.length).toBeGreaterThan(0);
        expect(secret.setCommand.length).toBeGreaterThan(0);
      }
    }
  });

  // -- Lookup helpers -------------------------------------------------------

  test("listCatalogProviderIds returns IDs matching listCatalogProviders", () => {
    expect(ids).toEqual(entries.map((e) => e.id));
  });

  test("getCatalogProvider returns the correct entry for each known ID", () => {
    for (const entry of entries) {
      const resolved = getCatalogProvider(entry.id);
      expect(resolved).toBe(entry);
    }
  });

  test("getCatalogProvider throws for unknown provider ID", () => {
    expect(() => getCatalogProvider("nonexistent-provider")).toThrow(
      /Unknown TTS provider "nonexistent-provider"/,
    );
  });

  test("getCatalogProvider error message includes known provider IDs", () => {
    try {
      getCatalogProvider("nonexistent-provider");
      throw new Error("Expected getCatalogProvider to throw");
    } catch (err) {
      const msg = (err as Error).message;
      for (const id of ids) {
        expect(msg).toContain(id);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Provider-specific assertions
// ---------------------------------------------------------------------------

describe("ElevenLabs catalog entry", () => {
  const entry = getCatalogProvider("elevenlabs");

  test("uses native-twilio call mode", () => {
    expect(entry.callMode).toBe("native-twilio");
  });

  test("does not support streaming", () => {
    expect(entry.capabilities.supportsStreaming).toBe(false);
  });

  test("supports mp3 format", () => {
    expect(entry.capabilities.supportedFormats).toContain("mp3");
  });

  test("requires an API key stored under 'elevenlabs'", () => {
    const apiKeySecret = entry.secretRequirements.find(
      (s) => s.credentialStoreKey === "elevenlabs",
    );
    expect(apiKeySecret).toBeDefined();
    expect(apiKeySecret!.displayName).toContain("ElevenLabs");
  });
});

describe("Fish Audio catalog entry", () => {
  const entry = getCatalogProvider("fish-audio");

  test("uses synthesized-play call mode", () => {
    expect(entry.callMode).toBe("synthesized-play");
  });

  test("supports streaming", () => {
    expect(entry.capabilities.supportsStreaming).toBe(true);
  });

  test("supports mp3, wav, and opus formats", () => {
    expect(entry.capabilities.supportedFormats).toContain("mp3");
    expect(entry.capabilities.supportedFormats).toContain("wav");
    expect(entry.capabilities.supportedFormats).toContain("opus");
  });

  test("requires an API key stored under 'credential/fish-audio/api_key'", () => {
    const apiKeySecret = entry.secretRequirements.find(
      (s) => s.credentialStoreKey === "credential/fish-audio/api_key",
    );
    expect(apiKeySecret).toBeDefined();
    expect(apiKeySecret!.displayName).toContain("Fish Audio");
  });
});
