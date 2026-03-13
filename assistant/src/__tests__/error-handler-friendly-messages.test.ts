import { describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

let mockAssistantApiKey = "";

const actualSecureKeys = await import("../security/secure-keys.js");
mock.module("../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKey: (key: string) => {
    if (key === credentialKey("vellum", "assistant_api_key")) {
      return mockAssistantApiKey || null;
    }
    return null;
  },
}));

import { withErrorHandling } from "../runtime/middleware/error-handler.js";
import { ConfigError, ProviderNotConfiguredError } from "../util/errors.js";

describe("withErrorHandling – friendly error messages", () => {
  test("ProviderNotConfiguredError without Vellum API key suggests hatch and env var", async () => {
    // GIVEN no Vellum API key is configured
    mockAssistantApiKey = "";

    // WHEN a ProviderNotConfiguredError is thrown for anthropic
    const response = await withErrorHandling("test", async () => {
      throw new ProviderNotConfiguredError("anthropic", []);
    });

    // THEN the response guides the user to run hatch or set the env var
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(body.error.message).toContain("No API key configured");
    expect(body.error.message).toContain("ANTHROPIC_API_KEY");
    expect(body.error.message).toContain("vellum hatch");
  });

  test("ProviderNotConfiguredError tailors env var to requested provider", async () => {
    // GIVEN no Vellum API key is configured
    mockAssistantApiKey = "";

    // WHEN a ProviderNotConfiguredError is thrown for openai
    const response = await withErrorHandling("test", async () => {
      throw new ProviderNotConfiguredError("openai", []);
    });

    // THEN the message references OPENAI_API_KEY, not ANTHROPIC_API_KEY
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toContain("OPENAI_API_KEY");
    expect(body.error.message).not.toContain("ANTHROPIC_API_KEY");
  });

  test("ProviderNotConfiguredError with Vellum API key does not suggest setting provider key", async () => {
    // GIVEN a Vellum API key is configured
    mockAssistantApiKey = "vellum-key-123";

    // WHEN a ProviderNotConfiguredError is thrown
    const response = await withErrorHandling("test", async () => {
      throw new ProviderNotConfiguredError("anthropic", []);
    });

    // THEN the message mentions the Vellum API key and does not suggest setting ANTHROPIC_API_KEY
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toContain("Vellum API key is set");
    expect(body.error.message).toContain("managed proxy");
    expect(body.error.message).not.toContain("ANTHROPIC_API_KEY");
    mockAssistantApiKey = "";
  });

  test("generic ConfigError still returns its own message", async () => {
    const response = await withErrorHandling("test", async () => {
      throw new ConfigError("Twilio phone number not configured.");
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toBe("Twilio phone number not configured.");
  });
});
