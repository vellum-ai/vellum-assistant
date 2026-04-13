import { afterEach, describe, expect, test } from "bun:test";

import {
  _resetTtsProviderRegistry,
  getTtsProvider,
  listTtsProviders,
  registerTtsProvider,
} from "../provider-registry.js";
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

describe("TTS provider registry", () => {
  afterEach(() => {
    _resetTtsProviderRegistry();
  });

  // -- Registration & lookup ------------------------------------------------

  test("registers and resolves a provider by ID", () => {
    const provider = stubProvider("test-provider");
    registerTtsProvider(provider);

    const resolved = getTtsProvider("test-provider");
    expect(resolved).toBe(provider);
  });

  test("rejects duplicate registration with an explicit error", () => {
    registerTtsProvider(stubProvider("dup"));

    expect(() => registerTtsProvider(stubProvider("dup"))).toThrow(
      /already registered/,
    );
  });

  // -- Unknown provider errors ----------------------------------------------

  test("throws for unknown provider ID when registry is empty", () => {
    expect(() => getTtsProvider("nope")).toThrow(/Unknown TTS provider "nope"/);
  });

  test("throws for unknown provider ID and lists known providers", () => {
    registerTtsProvider(stubProvider("alpha"));
    registerTtsProvider(stubProvider("beta"));

    try {
      getTtsProvider("gamma");
      throw new Error("Expected getTtsProvider to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/Unknown TTS provider "gamma"/);
      expect(msg).toMatch(/alpha/);
      expect(msg).toMatch(/beta/);
    }
  });

  // -- Listing order --------------------------------------------------------

  test("listTtsProviders returns providers in registration order", () => {
    registerTtsProvider(stubProvider("charlie"));
    registerTtsProvider(stubProvider("alpha"));
    registerTtsProvider(stubProvider("bravo"));

    const ids = listTtsProviders().map((p) => p.id);
    expect(ids).toEqual(["charlie", "alpha", "bravo"]);
  });

  test("listTtsProviders returns empty array when nothing is registered", () => {
    expect(listTtsProviders()).toEqual([]);
  });
});
