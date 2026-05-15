import { describe, expect, test } from "bun:test";

import {
  configureHatchProviderApiKey,
  resolveHatchProvider,
  type ProviderSecretFetch,
} from "../lib/provider-secrets.js";

interface RecordedFetchCall {
  url: string;
  init?: RequestInit;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetch(responses: Response[]): {
  calls: RecordedFetchCall[];
  fetchImpl: ProviderSecretFetch;
} {
  const calls: RecordedFetchCall[] = [];
  const fetchImpl: ProviderSecretFetch = async (input, init) => {
    calls.push({
      url: String(input),
      init,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected fetch call.");
    }
    return response;
  };

  return { calls, fetchImpl };
}

describe("hatch provider secrets", () => {
  test("defaults hatch provider setup to Anthropic", () => {
    expect(resolveHatchProvider({})).toBe("anthropic");
  });

  test("uses llm.default.provider override for hatch provider setup", () => {
    expect(resolveHatchProvider({ "llm.default.provider": "openai" })).toBe(
      "openai",
    );
  });

  test("uses active profile provider for hatch provider setup", () => {
    expect(
      resolveHatchProvider({
        "llm.activeProfile": "work",
        "llm.profiles.work.provider": "openai",
      }),
    ).toBe("openai");
  });

  test("infers active profile provider from model for hatch provider setup", () => {
    expect(
      resolveHatchProvider({
        "llm.activeProfile": "work",
        "llm.profiles.work.model": "gpt-5.4",
      }),
    ).toBe("openai");
  });

  test("active profile provider wins over main agent call-site provider", () => {
    expect(
      resolveHatchProvider({
        "llm.activeProfile": "work",
        "llm.profiles.work.provider": "openai",
        "llm.callSites.mainAgent.provider": "gemini",
      }),
    ).toBe("openai");
  });

  test("uses default provider before static main agent call-site provider", () => {
    expect(
      resolveHatchProvider({
        "llm.default.provider": "anthropic",
        "llm.callSites.mainAgent.provider": "gemini",
      }),
    ).toBe("anthropic");
  });

  test("uses default provider before static main agent call-site profile", () => {
    expect(
      resolveHatchProvider({
        "llm.default.provider": "anthropic",
        "llm.callSites.mainAgent.profile": "work",
        "llm.profiles.work.provider": "openai",
      }),
    ).toBe("anthropic");
  });

  test("uses main agent call-site provider when no hatch default exists", () => {
    expect(
      resolveHatchProvider({
        "llm.callSites.mainAgent.provider": "gemini",
      }),
    ).toBe("gemini");
  });

  test("uses main agent call-site profile when no hatch default exists", () => {
    expect(
      resolveHatchProvider({
        "llm.callSites.mainAgent.profile": "work",
        "llm.profiles.work.provider": "openai",
      }),
    ).toBe("openai");
  });

  test("infers default provider from model before falling back to Anthropic", () => {
    expect(
      resolveHatchProvider({ "llm.default.model": "gemini-2.5-flash" }),
    ).toBe("gemini");
  });

  test("skips hatch provider setup for ollama", () => {
    expect(
      resolveHatchProvider({ "llm.default.provider": "ollama" }),
    ).toBeNull();
  });

  test("skips hatch provider setup for active Ollama profile", () => {
    expect(
      resolveHatchProvider({
        "llm.activeProfile": "local",
        "llm.profiles.local.model": "llama3.2",
      }),
    ).toBeNull();
  });

  test("rejects unsupported hatch providers before hatch starts", () => {
    expect(() =>
      resolveHatchProvider({ "llm.default.provider": "custom" }),
    ).toThrow("supported API-key setup flow");
  });

  test("configures default Anthropic credentials from the environment", async () => {
    const { calls, fetchImpl } = makeFetch([
      jsonResponse({ found: false }),
      jsonResponse({ success: true }),
    ]);
    const logs: string[] = [];

    await configureHatchProviderApiKey({
      gatewayUrl: "http://127.0.0.1:7830",
      provider: resolveHatchProvider({}),
      bearerToken: "guardian-token",
      env: { ANTHROPIC_API_KEY: "test-anthropic-key" },
      fetchImpl,
      log: (message) => logs.push(message),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].body).toEqual({
      type: "api_key",
      name: "anthropic",
      reveal: false,
    });
    expect(calls[0].init?.headers).toMatchObject({
      Authorization: "Bearer guardian-token",
    });
    expect(calls[1].body).toEqual({
      type: "api_key",
      name: "anthropic",
      value: "test-anthropic-key",
    });
    expect(logs.join("\n")).toContain(
      "Configured Anthropic credentials from ANTHROPIC_API_KEY.",
    );
    expect(logs.join("\n")).not.toContain("test-anthropic-key");
  });

  test("uses OpenAI override and skips prompt when credentials already exist", async () => {
    const { calls, fetchImpl } = makeFetch([jsonResponse({ found: true })]);
    const logs: string[] = [];
    let prompted = false;

    await configureHatchProviderApiKey({
      gatewayUrl: "http://127.0.0.1:7830",
      provider: resolveHatchProvider({ "llm.default.provider": "openai" }),
      bearerToken: "guardian-token",
      env: {},
      fetchImpl,
      prompt: async () => {
        prompted = true;
        return "unused";
      },
      log: (message) => logs.push(message),
    });

    expect(prompted).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      type: "api_key",
      name: "openai",
      reveal: false,
    });
    expect(logs.join("\n")).toContain(
      "Provider credentials already configured for OpenAI.",
    );
  });

  test("uses active profile provider when selecting environment credential", async () => {
    const { calls, fetchImpl } = makeFetch([
      jsonResponse({ found: false }),
      jsonResponse({ success: true }),
    ]);

    await configureHatchProviderApiKey({
      gatewayUrl: "http://127.0.0.1:7830",
      provider: resolveHatchProvider({
        "llm.activeProfile": "work",
        "llm.profiles.work.provider": "openai",
      }),
      bearerToken: "guardian-token",
      env: { OPENAI_API_KEY: "test-openai-key" },
      fetchImpl,
      log: () => {},
    });

    expect(calls[0].body).toEqual({
      type: "api_key",
      name: "openai",
      reveal: false,
    });
    expect(calls[1].body).toEqual({
      type: "api_key",
      name: "openai",
      value: "test-openai-key",
    });
  });

  test("keeps hatch recoverable when provider credentials are missing in a non-interactive shell", async () => {
    const { fetchImpl } = makeFetch([jsonResponse({ found: false })]);
    const logs: string[] = [];

    await configureHatchProviderApiKey({
      gatewayUrl: "http://127.0.0.1:7830",
      provider: "anthropic",
      env: {},
      fetchImpl,
      stdinIsTTY: false,
      log: (message) => logs.push(message),
    });

    const output = logs.join("\n");
    expect(output).toContain("Provider credential setup skipped");
    expect(output).toContain("Missing ANTHROPIC_API_KEY");
    expect(output).toContain("vellum setup --provider anthropic");
  });

  test("surfaces gateway validation failures without throwing or logging the key", async () => {
    const { fetchImpl } = makeFetch([
      jsonResponse({ found: false }),
      jsonResponse(
        { error: { message: "API key is invalid or expired." } },
        400,
      ),
    ]);
    const logs: string[] = [];

    await configureHatchProviderApiKey({
      gatewayUrl: "http://127.0.0.1:7830",
      provider: "anthropic",
      env: { ANTHROPIC_API_KEY: "test-anthropic-key" },
      fetchImpl,
      log: (message) => logs.push(message),
    });

    const output = logs.join("\n");
    expect(output).toContain("Provider credential setup failed");
    expect(output).toContain("API key is invalid or expired.");
    expect(output).toContain("vellum setup --provider anthropic");
    expect(output).not.toContain("test-anthropic-key");
  });
});
