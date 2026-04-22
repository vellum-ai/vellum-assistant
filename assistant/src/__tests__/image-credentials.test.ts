import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must appear before importing the module under test
// ---------------------------------------------------------------------------

let mockProviderKey: string | undefined;
let mockManagedBaseUrl: string | undefined;
let mockAssistantApiKey = "";

mock.module("../security/secure-keys.js", () => ({
  getProviderKeyAsync: async (_provider: string) => mockProviderKey,
}));

mock.module("../providers/managed-proxy/context.js", () => ({
  buildManagedBaseUrl: async (_provider: string) => mockManagedBaseUrl,
  resolveManagedProxyContext: async () => ({
    enabled: !!mockManagedBaseUrl,
    platformBaseUrl: mockManagedBaseUrl ? "https://platform.example.com" : "",
    assistantApiKey: mockAssistantApiKey,
  }),
}));

// Import after mocks
import { resolveImageGenCredentials } from "../media/image-credentials.js";

describe("resolveImageGenCredentials", () => {
  beforeEach(() => {
    mockProviderKey = undefined;
    mockManagedBaseUrl = undefined;
    mockAssistantApiKey = "";
  });

  describe("managed mode", () => {
    test("returns managed-proxy credentials when buildManagedBaseUrl resolves", async () => {
      mockManagedBaseUrl = "https://platform.example.com/proxy/gemini";
      mockAssistantApiKey = "sk-assistant-key";

      const result = await resolveImageGenCredentials({
        provider: "gemini",
        mode: "managed",
      });

      expect(result.errorHint).toBeUndefined();
      expect(result.credentials).toEqual({
        type: "managed-proxy",
        assistantApiKey: "sk-assistant-key",
        baseUrl: "https://platform.example.com/proxy/gemini",
      });
    });

    test("returns errorHint mentioning 'log in to Vellum' when managed base URL is unavailable", async () => {
      mockManagedBaseUrl = undefined;

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
