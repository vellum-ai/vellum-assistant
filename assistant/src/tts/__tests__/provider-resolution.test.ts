import { afterEach, describe, expect, test } from "bun:test";

import {
  _resetTtsProviderOverridesForTests,
  _setTtsProviderForTests,
  getTtsProvider,
  listCatalogProviderIds,
} from "../provider-catalog.js";
import type { TtsProvider } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubProvider(id: string): TtsProvider {
  return {
    id,
    capabilities: {
      supportsStreaming: false,
      supportedFormats: ["mp3"],
    },
    async synthesize() {
      return { audio: Buffer.alloc(0), contentType: "audio/mpeg" };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TTS provider resolution", () => {
  afterEach(() => {
    _resetTtsProviderOverridesForTests();
  });

  // -- Static resolution ------------------------------------------------------

  test("resolves every catalog provider to an adapter with a matching ID", () => {
    for (const id of listCatalogProviderIds()) {
      const provider = getTtsProvider(id);
      expect(provider.id).toBe(id);
      expect(typeof provider.synthesize).toBe("function");
    }
  });

  test("throws for an unknown provider ID and lists known providers", () => {
    try {
      getTtsProvider("nope");
      throw new Error("Expected getTtsProvider to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/Unknown TTS provider "nope"/);
      expect(msg).toMatch(/elevenlabs/);
    }
  });

  // -- Test overrides ---------------------------------------------------------

  test("an override shadows the catalog adapter with the same ID", () => {
    const stub = stubProvider("elevenlabs");
    _setTtsProviderForTests(stub);

    expect(getTtsProvider("elevenlabs")).toBe(stub);
  });

  test("an override can add a provider under a non-catalog ID", () => {
    const stub = stubProvider("test-only-provider");
    _setTtsProviderForTests(stub);

    expect(getTtsProvider("test-only-provider")).toBe(stub);
  });

  test("resetting overrides restores the catalog adapter", () => {
    const stub = stubProvider("elevenlabs");
    _setTtsProviderForTests(stub);
    _resetTtsProviderOverridesForTests();

    const resolved = getTtsProvider("elevenlabs");
    expect(resolved).not.toBe(stub);
    expect(resolved.id).toBe("elevenlabs");
  });
});
