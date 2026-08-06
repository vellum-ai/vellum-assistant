import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must appear before importing the module under test
// ---------------------------------------------------------------------------

let mockProviderKey: string | undefined;
let mockPlatformBaseUrl = "";
let mockAssistantApiKey = "";

mock.module("../security/secure-keys.js", () => ({
  getProviderKeyAsync: async (_provider: string) => mockProviderKey,
}));

mock.module("../providers/platform-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => ({
    enabled: !!mockPlatformBaseUrl && !!mockAssistantApiKey,
    platformBaseUrl: mockPlatformBaseUrl,
    assistantApiKey: mockAssistantApiKey,
  }),
}));

// Import after mocks
import {
  resolveImageGenCredentials,
  resolveImageGenRouting,
} from "../media/image-credentials.js";

describe("resolveImageGenCredentials", () => {
  beforeEach(() => {
    mockProviderKey = undefined;
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = "";
  });

  describe("managed mode", () => {
    test("returns managed-proxy credentials when context is enabled", async () => {
      mockPlatformBaseUrl = "https://platform.example.com";
      mockAssistantApiKey = "sk-assistant-key";

      const result = await resolveImageGenCredentials({
        provider: "gemini",
        managed: true,
      });

      expect(result.errorHint).toBeUndefined();
      expect(result.credentials).toEqual({
        type: "managed-proxy",
        assistantApiKey: "sk-assistant-key",
        baseUrl: "https://platform.example.com/v1/runtime-proxy/gemini",
      });
    });

    test("returns errorHint mentioning 'log in to Vellum' when platform URL is missing", async () => {
      mockPlatformBaseUrl = "";
      mockAssistantApiKey = "sk-assistant-key";

      const result = await resolveImageGenCredentials({
        provider: "gemini",
        managed: true,
      });

      expect(result.credentials).toBeUndefined();
      expect(result.errorHint).toBeDefined();
      expect(result.errorHint).toContain("log in to Vellum");
    });

    test("returns errorHint when assistant API key is empty (TOCTOU-safe)", async () => {
      mockPlatformBaseUrl = "https://platform.example.com";
      mockAssistantApiKey = "";

      const result = await resolveImageGenCredentials({
        provider: "gemini",
        managed: true,
      });

      expect(result.credentials).toBeUndefined();
      expect(result.errorHint).toBeDefined();
      expect(result.errorHint).toContain("log in to Vellum");
    });
  });

  describe("your-own mode", () => {
    test("returns direct credentials for gemini when key is present", async () => {
      mockProviderKey = "gemini-api-key";

      const result = await resolveImageGenCredentials({
        provider: "gemini",
        managed: false,
      });

      expect(result.errorHint).toBeUndefined();
      expect(result.credentials).toEqual({
        type: "direct",
        apiKey: "gemini-api-key",
      });
    });

    test("returns errorHint mentioning 'Gemini API key' when no key is set", async () => {
      mockProviderKey = undefined;

      const result = await resolveImageGenCredentials({
        provider: "gemini",
        managed: false,
      });

      expect(result.credentials).toBeUndefined();
      expect(result.errorHint).toBeDefined();
      expect(result.errorHint).toContain("Gemini API key");
    });

    test("returns direct credentials for openai when key is present", async () => {
      mockProviderKey = "openai-api-key";

      const result = await resolveImageGenCredentials({
        provider: "openai",
        managed: false,
      });

      expect(result.errorHint).toBeUndefined();
      expect(result.credentials).toEqual({
        type: "direct",
        apiKey: "openai-api-key",
      });
    });

    test("returns errorHint mentioning 'OpenAI API key' when no key is set", async () => {
      mockProviderKey = undefined;

      const result = await resolveImageGenCredentials({
        provider: "openai",
        managed: false,
      });

      expect(result.credentials).toBeUndefined();
      expect(result.errorHint).toBeDefined();
      expect(result.errorHint).toContain("OpenAI API key");
    });
  });
});

describe("resolveImageGenRouting", () => {
  test("provider vellum is managed with a gemini backend for gemini models", () => {
    expect(
      resolveImageGenRouting({
        provider: "vellum",
        model: "gemini-3.1-flash-image-preview",
      }),
    ).toEqual({ backendProvider: "gemini", managed: true });
  });

  test("provider vellum derives an openai backend from a gpt model", () => {
    expect(
      resolveImageGenRouting({ provider: "vellum", model: "gpt-image-2" }),
    ).toEqual({ backendProvider: "openai", managed: true });
  });

  test("a model override wins over the stored model under vellum", () => {
    expect(
      resolveImageGenRouting(
        { provider: "vellum", model: "gemini-3.1-flash-image-preview" },
        "gpt-image-2",
      ),
    ).toEqual({ backendProvider: "openai", managed: true });
  });

  test("BYOK providers keep the override re-routing without managed", () => {
    expect(
      resolveImageGenRouting(
        { provider: "gemini", model: "gemini-3.1-flash-image-preview" },
        "gpt-image-2",
      ),
    ).toEqual({ backendProvider: "openai", managed: false });
  });

  test("vellum with an unavailable platform is a hard error, not a BYOK fallback", async () => {
    // Billing rule: an explicit vellum choice never silently spends a stored
    // provider key.
    mockProviderKey = "gemini-key-should-not-be-used";
    mockPlatformBaseUrl = "";

    const routing = resolveImageGenRouting({
      provider: "vellum",
      model: "gemini-3.1-flash-image-preview",
    });
    const result = await resolveImageGenCredentials({
      provider: routing.backendProvider,
      managed: routing.managed,
    });

    expect(result.credentials).toBeUndefined();
    expect(result.errorHint).toContain("Managed proxy is not available");
  });
});
