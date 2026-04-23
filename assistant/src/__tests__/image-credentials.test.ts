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

mock.module("../providers/managed-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => ({
    enabled: !!mockPlatformBaseUrl && !!mockAssistantApiKey,
    platformBaseUrl: mockPlatformBaseUrl,
    assistantApiKey: mockAssistantApiKey,
  }),
}));

// Import after mocks
import { resolveImageGenCredentials } from "../media/image-credentials.js";

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
        mode: "managed",
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
        mode: "managed",
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
        mode: "managed",
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
        mode: "your-own",
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
        mode: "your-own",
      });

      expect(result.credentials).toBeUndefined();
      expect(result.errorHint).toBeDefined();
      expect(result.errorHint).toContain("Gemini API key");
    });

    test("returns direct credentials for openai when key is present", async () => {
      mockProviderKey = "openai-api-key";

      const result = await resolveImageGenCredentials({
        provider: "openai",
        mode: "your-own",
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
        mode: "your-own",
      });

      expect(result.credentials).toBeUndefined();
      expect(result.errorHint).toBeDefined();
      expect(result.errorHint).toContain("OpenAI API key");
    });
  });
});
