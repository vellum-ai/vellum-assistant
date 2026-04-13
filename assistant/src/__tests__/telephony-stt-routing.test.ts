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
// Tests — Provider-to-strategy mapping
// ---------------------------------------------------------------------------

describe("resolveTelephonySttRouting", () => {
  beforeEach(() => {
    mockConfig = buildConfig({});
  });

  // -----------------------------------------------------------------------
  // Deepgram → conversation-relay-native
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
  });

  // -----------------------------------------------------------------------
  // Google Gemini → conversation-relay-native
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
  });

  // -----------------------------------------------------------------------
  // OpenAI Whisper → media-stream-custom
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
});
