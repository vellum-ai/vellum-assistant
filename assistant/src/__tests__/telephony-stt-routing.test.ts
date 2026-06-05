import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any subject imports
// ---------------------------------------------------------------------------

// -- Logger mock ----------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// -- Config mock ----------------------------------------------------------

let mockConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
}));

// ---------------------------------------------------------------------------
// Subject import (after mocks)
// ---------------------------------------------------------------------------

import {
  type MediaStreamCustomStrategy,
  resolveTelephonySttRouting,
} from "../calls/telephony-stt-routing.js";
import { listProviderEntries } from "../providers/speech-to-text/provider-catalog.js";
import type { SttProviderId } from "../stt/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConfig(overrides: {
  provider?: string;
}): Record<string, unknown> {
  return {
    services: {
      stt: {
        mode: "your-own",
        provider: overrides.provider ?? "deepgram",
        providers: {},
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — Provider-to-strategy mapping (catalog-driven)
// ---------------------------------------------------------------------------

describe("resolveTelephonySttRouting", () => {
  beforeEach(() => {
    mockConfig = buildConfig({});
  });

  // -----------------------------------------------------------------------
  // Every provider resolves to media-stream-custom (from catalog)
  // -----------------------------------------------------------------------

  describe("media-stream-custom routing", () => {
    test.each([
      "deepgram",
      "google-gemini",
      "openai-whisper",
      "xai",
    ] satisfies SttProviderId[])(
      "%s resolves to media-stream-custom with its providerId",
      (provider) => {
        mockConfig = buildConfig({ provider });

        const result = resolveTelephonySttRouting();

        expect(result.status).toBe("resolved");
        if (result.status !== "resolved") return;

        expect(result.strategy.strategy).toBe("media-stream-custom");
        const strategy = result.strategy as MediaStreamCustomStrategy;
        expect(strategy.providerId).toBe(provider);
      },
    );

    test("media-stream-custom strategy carries no Twilio-native fields", () => {
      mockConfig = buildConfig({ provider: "deepgram" });

      const result = resolveTelephonySttRouting();

      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") return;

      expect(result.strategy.strategy).toBe("media-stream-custom");
      expect("speechModel" in result.strategy).toBe(false);
      expect("transcriptionProvider" in result.strategy).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Unknown / malformed provider handling
  // -----------------------------------------------------------------------

  describe("unknown provider handling", () => {
    test("returns unknown-provider for a provider not in the catalog", () => {
      mockConfig = buildConfig({ provider: "nonexistent-provider" as string });

      const result = resolveTelephonySttRouting();

      expect(result.status).toBe("unknown-provider");
      if (result.status !== "unknown-provider") return;

      expect(result.providerId).toBe("nonexistent-provider");
      expect(result.reason).toContain("nonexistent-provider");
      expect(result.reason).toContain("not in the provider catalog");
    });

    test("returns unknown-provider for empty-string provider", () => {
      mockConfig = buildConfig({ provider: "" as string });

      const result = resolveTelephonySttRouting();

      expect(result.status).toBe("unknown-provider");
    });
  });

  // -----------------------------------------------------------------------
  // Catalog-driven mapping verification
  // -----------------------------------------------------------------------

  describe("catalog-driven mapping", () => {
    test("no catalog entry declares conversation-relay-native routing", () => {
      const nativeEntries = listProviderEntries().filter(
        (e) =>
          (e.telephonyRouting.strategyKind as string) ===
          "conversation-relay-native",
      );
      expect(nativeEntries).toHaveLength(0);
    });

    test("every catalog entry resolves to media-stream-custom", () => {
      const entries = listProviderEntries();
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        expect(entry.telephonyRouting.strategyKind).toBe("media-stream-custom");

        mockConfig = buildConfig({ provider: entry.id });

        const result = resolveTelephonySttRouting();
        expect(result.status).toBe("resolved");
        if (result.status !== "resolved") return;

        expect(result.strategy.strategy).toBe("media-stream-custom");
        expect(result.strategy.providerId).toBe(entry.id);
      }
    });

    test("routing module contains no hardcoded provider-to-Twilio map", async () => {
      // Read the source file and verify the hardcoded map was removed.
      // This is a structural assertion: the catalog is the sole source of truth.
      const sourceFile = Bun.file(
        new URL("../calls/telephony-stt-routing.ts", import.meta.url).pathname,
      );
      const source = await sourceFile.text();

      expect(source).not.toContain("TWILIO_NATIVE_PROVIDER_MAP");
      expect(source).not.toContain("new Map<SttProviderId");
      expect(source).not.toContain("DEEPGRAM_DEFAULT_SPEECH_MODEL");
    });
  });
});
