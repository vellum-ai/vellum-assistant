import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type { AssistantEntry } from "../lib/assistant-config.js";

let activeAssistant: AssistantEntry | null = null;

interface SetupEnsureOptions {
  gatewayUrl: string;
  provider: string;
  bearerToken?: string;
  env?: NodeJS.ProcessEnv;
}

const resolveAssistantMock = mock((): AssistantEntry | null => activeAssistant);
const loadGuardianTokenMock = mock(
  (_assistantId: string): { accessToken: string } | null => ({
    accessToken: "guardian-token",
  }),
);
const ensureProviderApiKeyMock = mock(async (options: SetupEnsureOptions) => ({
  status: "configured" as const,
  provider: options.provider,
  source: "prompt" as const,
}));

mock.module("../lib/assistant-config.js", () => ({
  resolveAssistant: resolveAssistantMock,
}));

mock.module("../lib/guardian-token.js", () => ({
  loadGuardianToken: loadGuardianTokenMock,
}));

mock.module("../lib/provider-secrets.js", () => ({
  ensureProviderApiKey: ensureProviderApiKeyMock,
  formatProviderName: (provider: string) =>
    provider === "openai" ? "OpenAI" : "Anthropic",
}));

import { setup } from "../commands/setup.js";

const originalArgv = [...process.argv];
const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

describe("setup command", () => {
  beforeEach(() => {
    process.argv = ["bun", "vellum", "setup"];
    activeAssistant = {
      assistantId: "assistant-123",
      runtimeUrl: "http://runtime.example",
      localUrl: "http://127.0.0.1:3000",
      cloud: "local",
    };
    resolveAssistantMock.mockClear();
    loadGuardianTokenMock.mockReset();
    loadGuardianTokenMock.mockReturnValue({ accessToken: "guardian-token" });
    ensureProviderApiKeyMock.mockReset();
    ensureProviderApiKeyMock.mockImplementation(
      async (options: SetupEnsureOptions) => ({
        status: "configured" as const,
        provider: options.provider,
        source: "prompt" as const,
      }),
    );
    consoleLogSpy.mockClear();
    consoleErrorSpy.mockClear();
  });

  afterAll(() => {
    process.argv = originalArgv;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test("configures the default provider through the active assistant gateway", async () => {
    await setup();

    expect(resolveAssistantMock).toHaveBeenCalled();
    expect(loadGuardianTokenMock).toHaveBeenCalledWith("assistant-123");
    expect(ensureProviderApiKeyMock).toHaveBeenCalledTimes(1);

    const options = ensureProviderApiKeyMock.mock.calls[0][0];
    expect(options.gatewayUrl).toBe("http://127.0.0.1:3000");
    expect(options.provider).toBe("anthropic");
    expect(options.bearerToken).toBe("guardian-token");
    expect(options.env).toBe(process.env);
  });

  test("honors an explicit provider option", async () => {
    process.argv = ["bun", "vellum", "setup", "--provider", "openai"];

    await setup();

    const options = ensureProviderApiKeyMock.mock.calls[0][0];
    expect(options.provider).toBe("openai");
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "OpenAI API key saved to assistant.",
    );
  });

  test("falls back to runtime URL and lockfile bearer token", async () => {
    activeAssistant = {
      assistantId: "assistant-123",
      runtimeUrl: "https://assistant.example",
      bearerToken: "entry-token",
      cloud: "vellum",
    };
    loadGuardianTokenMock.mockReturnValue(null);

    await setup();

    const options = ensureProviderApiKeyMock.mock.calls[0][0];
    expect(options.gatewayUrl).toBe("https://assistant.example");
    expect(options.bearerToken).toBe("entry-token");
  });
});
