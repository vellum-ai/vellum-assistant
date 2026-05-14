import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AssistantEntry } from "../lib/assistant-config.js";
import * as assistantConfig from "../lib/assistant-config.js";
import * as guardianToken from "../lib/guardian-token.js";
import * as providerSecrets from "../lib/provider-secrets.js";

let activeAssistant: AssistantEntry | null = null;

type SetupEnsureOptions = Parameters<
  typeof providerSecrets.ensureProviderApiKey
>[0];
type SetupEnsureResult = Awaited<
  ReturnType<typeof providerSecrets.ensureProviderApiKey>
>;

function guardianTokenFixture(
  overrides: Partial<
    NonNullable<ReturnType<typeof guardianToken.loadGuardianToken>>
  > = {},
): NonNullable<ReturnType<typeof guardianToken.loadGuardianToken>> {
  return {
    guardianPrincipalId: "guardian-principal-123",
    accessToken: "guardian-token",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshToken: "refresh-token",
    refreshTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    refreshAfter: new Date(Date.now() + 30_000).toISOString(),
    isNew: false,
    deviceId: "device-123",
    leasedAt: new Date().toISOString(),
    ...overrides,
  };
}

const resolveAssistantMock = spyOn(
  assistantConfig,
  "resolveAssistant",
).mockImplementation((): AssistantEntry | null => activeAssistant);
const loadGuardianTokenMock = spyOn(
  guardianToken,
  "loadGuardianToken",
).mockImplementation(
  (_assistantId: string): ReturnType<typeof guardianToken.loadGuardianToken> =>
    guardianTokenFixture(),
);
const refreshGuardianTokenMock = spyOn(
  guardianToken,
  "refreshGuardianToken",
).mockResolvedValue(null);
const configuredResult = (provider: string | null): SetupEnsureResult => ({
  status: "configured",
  provider:
    provider && providerSecrets.isSupportedLlmProvider(provider)
      ? provider
      : "anthropic",
  source: "prompt",
});
const ensureProviderApiKeyMock = spyOn(
  providerSecrets,
  "ensureProviderApiKey",
).mockImplementation(async (options: SetupEnsureOptions) =>
  configuredResult(options.provider),
);
const formatProviderNameMock = spyOn(
  providerSecrets,
  "formatProviderName",
).mockImplementation((provider: string) =>
  provider === "openai" ? "OpenAI" : "Anthropic",
);

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
    loadGuardianTokenMock.mockReturnValue(guardianTokenFixture());
    refreshGuardianTokenMock.mockReset();
    refreshGuardianTokenMock.mockResolvedValue(null);
    ensureProviderApiKeyMock.mockReset();
    ensureProviderApiKeyMock.mockImplementation(async (options) =>
      configuredResult(options.provider),
    );
    consoleLogSpy.mockClear();
    consoleErrorSpy.mockClear();
  });

  afterAll(() => {
    process.argv = originalArgv;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    resolveAssistantMock.mockRestore();
    loadGuardianTokenMock.mockRestore();
    refreshGuardianTokenMock.mockRestore();
    ensureProviderApiKeyMock.mockRestore();
    formatProviderNameMock.mockRestore();
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

  test("falls back to the lockfile bearer token when guardian token is expired", async () => {
    activeAssistant = {
      assistantId: "assistant-123",
      runtimeUrl: "https://assistant.example",
      bearerToken: "entry-token",
      cloud: "vellum",
    };
    loadGuardianTokenMock.mockReturnValue(
      guardianTokenFixture({
        accessToken: "expired-guardian-token",
        accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    refreshGuardianTokenMock.mockResolvedValue(null);

    await setup();

    expect(refreshGuardianTokenMock).toHaveBeenCalledWith(
      "https://assistant.example",
      "assistant-123",
    );
    const options = ensureProviderApiKeyMock.mock.calls[0][0];
    expect(options.bearerToken).toBe("entry-token");
  });

  test("uses a refreshed guardian token before lockfile fallback", async () => {
    activeAssistant = {
      assistantId: "assistant-123",
      runtimeUrl: "https://assistant.example",
      bearerToken: "entry-token",
      cloud: "vellum",
    };
    loadGuardianTokenMock.mockReturnValue(
      guardianTokenFixture({
        accessToken: "expired-guardian-token",
        accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    refreshGuardianTokenMock.mockResolvedValue(
      guardianTokenFixture({ accessToken: "fresh-guardian-token" }),
    );

    await setup();

    const options = ensureProviderApiKeyMock.mock.calls[0][0];
    expect(options.bearerToken).toBe("fresh-guardian-token");
  });
});
