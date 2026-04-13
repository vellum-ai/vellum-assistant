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
  type ConversationRelayNativeStrategy,
  type MediaStreamCustomStrategy,
  resolveTelephonySttRouting,
} from "../calls/telephony-stt-routing.js";
import {
  getProviderEntry,
  listProviderEntries,
} from "../providers/speech-to-text/provider-catalog.js";
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
  // Deepgram → conversation-relay-native (from catalog)
  // -----------------------------------------------------------------------

  describe("deepgram", () => {
    test("resolves to conversation-relay-native with Deepgram transcriptionProvider", () => {
      mockConfig = buildConfig({ provider: "deepgram" });

      const result = resolveTelephonySttRouting();

      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") return;

      expect(result.strategy.strategy).toBe("conversation-relay-native");
      const strategy = result.strategy as ConversationRelayNativeStrategy;
      expect(strategy.providerId).toBe("deepgram");
      expect(strategy.transcriptionProvider).toBe("Deepgram");
    });

    test("defaults speechModel to nova-3", () => {
      mockConfig = buildConfig({ provider: "deepgram" });

      const result = resolveTelephonySttRouting();

      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") return;

      const strategy = result.strategy as ConversationRelayNativeStrategy;
      expect(strategy.speechModel).toBe("nova-3");
    });

    test("speechModel matches catalog telephonyRouting.twilioNativeMapping.defaultSpeechModel", () => {
      mockConfig = buildConfig({ provider: "deepgram" });
      const entry = getProviderEntry("deepgram");

      const result = resolveTelephonySttRouting();

      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") return;

      const strategy = result.strategy as ConversationRelayNativeStrategy;
      expect(strategy.speechModel).toBe(
        entry?.telephonyRouting.twilioNativeMapping?.defaultSpeechModel,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Google Gemini → conversation-relay-native (from catalog)
  // -----------------------------------------------------------------------

  describe("google-gemini", () => {
    test("resolves to conversation-relay-native with Google transcriptionProvider", () => {
      mockConfig = buildConfig({ provider: "google-gemini" });

      const result = resolveTelephonySttRouting();

      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") return;

      expect(result.strategy.strategy).toBe("conversation-relay-native");
      const strategy = result.strategy as ConversationRelayNativeStrategy;
      expect(strategy.providerId).toBe("google-gemini");
      expect(strategy.transcriptionProvider).toBe("Google");
    });

    test("leaves speechModel undefined (uses provider default)", () => {
      mockConfig = buildConfig({ provider: "google-gemini" });

      const result = resolveTelephonySttRouting();

      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") return;

      const strategy = result.strategy as ConversationRelayNativeStrategy;
      expect(strategy.speechModel).toBeUndefined();
    });

    test("speechModel matches catalog telephonyRouting.twilioNativeMapping.defaultSpeechModel", () => {
      mockConfig = buildConfig({ provider: "google-gemini" });
      const entry = getProviderEntry("google-gemini");

      const result = resolveTelephonySttRouting();

      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") return;

      const strategy = result.strategy as ConversationRelayNativeStrategy;
      expect(strategy.speechModel).toBe(
        entry?.telephonyRouting.twilioNativeMapping?.defaultSpeechModel,
      );
    });
  });

  // -----------------------------------------------------------------------
  // OpenAI Whisper → media-stream-custom (from catalog)
  // -----------------------------------------------------------------------

  describe("openai-whisper", () => {
    test("resolves to media-stream-custom strategy", () => {
      mockConfig = buildConfig({ provider: "openai-whisper" });

      const result = resolveTelephonySttRouting();

      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") return;

      expect(result.strategy.strategy).toBe("media-stream-custom");
      const strategy = result.strategy as MediaStreamCustomStrategy;
      expect(strategy.providerId).toBe("openai-whisper");
    });

    test("media-stream-custom strategy does not include speechModel", () => {
      mockConfig = buildConfig({ provider: "openai-whisper" });

      const result = resolveTelephonySttRouting();

      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") return;

      // media-stream-custom has no speechModel property
      expect(result.strategy.strategy).toBe("media-stream-custom");
      expect("speechModel" in result.strategy).toBe(false);
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
  // Strategy discrimination correctness
  // -----------------------------------------------------------------------

  describe("strategy discrimination", () => {
    test("conversation-relay-native strategies always have transcriptionProvider", () => {
      for (const provider of ["deepgram", "google-gemini"]) {
        mockConfig = buildConfig({ provider });

        const result = resolveTelephonySttRouting();
        expect(result.status).toBe("resolved");
        if (result.status !== "resolved") return;

        expect(result.strategy.strategy).toBe("conversation-relay-native");
        const strategy = result.strategy as ConversationRelayNativeStrategy;
        expect(strategy.transcriptionProvider).toBeDefined();
        expect(strategy.transcriptionProvider.length).toBeGreaterThan(0);
      }
    });

    test("media-stream-custom strategies never have transcriptionProvider", () => {
      mockConfig = buildConfig({ provider: "openai-whisper" });

      const result = resolveTelephonySttRouting();
      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") return;

      expect(result.strategy.strategy).toBe("media-stream-custom");
      expect("transcriptionProvider" in result.strategy).toBe(false);
    });

    test("all resolved strategies include the original providerId", () => {
      const providers: SttProviderId[] = [
        "deepgram",
        "google-gemini",
        "openai-whisper",
      ];
      for (const provider of providers) {
        mockConfig = buildConfig({ provider });

        const result = resolveTelephonySttRouting();
        expect(result.status).toBe("resolved");
        if (result.status !== "resolved") return;

        expect(result.strategy.providerId).toBe(provider);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Catalog-driven mapping verification
  // -----------------------------------------------------------------------

  describe("catalog-driven mapping", () => {
    test("every catalog entry with conversation-relay-native routing resolves to that strategy", () => {
      const nativeEntries = listProviderEntries().filter(
        (e) => e.telephonyRouting.strategyKind === "conversation-relay-native",
      );
      expect(nativeEntries.length).toBeGreaterThan(0);

      for (const entry of nativeEntries) {
        mockConfig = buildConfig({ provider: entry.id });

        const result = resolveTelephonySttRouting();
        expect(result.status).toBe("resolved");
        if (result.status !== "resolved") return;

        expect(result.strategy.strategy).toBe("conversation-relay-native");
        const strategy = result.strategy as ConversationRelayNativeStrategy;
        expect(strategy.transcriptionProvider).toBe(
          entry.telephonyRouting.twilioNativeMapping!.provider,
        );
        expect(strategy.speechModel).toBe(
          entry.telephonyRouting.twilioNativeMapping!.defaultSpeechModel,
        );
      }
    });

    test("every catalog entry with media-stream-custom routing resolves to that strategy", () => {
      const customEntries = listProviderEntries().filter(
        (e) => e.telephonyRouting.strategyKind === "media-stream-custom",
      );
      expect(customEntries.length).toBeGreaterThan(0);

      for (const entry of customEntries) {
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
