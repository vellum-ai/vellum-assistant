import { afterEach, describe, expect, mock, test } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { callTelegramApi } = await import("../telegram/api.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: false,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 0,
    telegramTimeoutMs: 15000,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    whatsappDeliverAuthBypass: false,
    whatsappTimeoutMs: 15000,
    whatsappMaxRetries: 3,
    whatsappInitialBackoffMs: 1000,
    slackDeliverAuthBypass: false,
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

function makeCredentials(botToken: string) {
  return {
    get: async (key: string) =>
      key === "credential:telegram:bot_token" ? botToken : undefined,
    invalidate: () => {},
  } as unknown as CredentialCache;
}

describe("callTelegramApi transport error redaction", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("redacts bot token from warning logs and thrown error", async () => {
    const tgToken = [
      "123456789",
      ":",
      "ABCDefGHIJklmnopQRSTuvwxyz012345678",
    ].join("");

    fetchMock = mock(async () => {
      const err = new Error(
        "Unable to connect. Is the computer able to access the url?",
      ) as Error & {
        path?: string;
        code?: string;
      };
      err.path = `https://api.telegram.org/bot${tgToken}/sendMessage`;
      err.code = "ConnectionRefused";
      throw err;
    });

    const config = makeConfig({
      telegramMaxRetries: 0,
    });

    let thrown: Error | null = null;
    try {
      await callTelegramApi(
        config,
        "sendMessage",
        {
          chat_id: "1",
          text: "hello",
        },
        { credentials: makeCredentials(tgToken) },
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain(tgToken);
    expect(thrown?.message).toContain("[REDACTED]");
  });

  test("redacts bot token preceded by hyphen delimiter", async () => {
    // Tokens embedded after a hyphen (e.g., diagnostic strings like
    // "error-123456789:...") must still be redacted.
    const tgToken = [
      "123456789",
      ":",
      "ABCDefGHIJklmnopQRSTuvwxyz012345678",
    ].join("");

    fetchMock = mock(async () => {
      const err = new Error("Connection refused") as Error & {
        path?: string;
        code?: string;
      };
      // Simulate a diagnostic string where the token is preceded by a hyphen
      err.path = `prefix-${tgToken}/sendMessage`;
      err.code = "ConnectionRefused";
      throw err;
    });

    const config = makeConfig({
      telegramMaxRetries: 0,
    });

    let thrown: Error | null = null;
    try {
      await callTelegramApi(
        config,
        "sendMessage",
        {
          chat_id: "1",
          text: "hello",
        },
        { credentials: makeCredentials(tgToken) },
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain(tgToken);
    expect(thrown?.message).toContain("[REDACTED]");
  });

  test("redacts bot token ending with hyphen", async () => {
    // Tokens can end with `-` which is a non-word character; \b boundaries
    // would fail to match the trailing `-`, leaking part of the token.
    const tgToken = [
      "123456789",
      ":",
      "ABCDefGHIJklmnopQRSTuvwxyz01234567-",
    ].join("");

    fetchMock = mock(async () => {
      const err = new Error("Connection refused") as Error & {
        path?: string;
        code?: string;
      };
      err.path = `https://api.telegram.org/bot${tgToken}/sendMessage`;
      err.code = "ConnectionRefused";
      throw err;
    });

    const config = makeConfig({
      telegramMaxRetries: 0,
    });

    let thrown: Error | null = null;
    try {
      await callTelegramApi(
        config,
        "sendMessage",
        {
          chat_id: "1",
          text: "hello",
        },
        { credentials: makeCredentials(tgToken) },
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain(tgToken);
    expect(thrown?.message).toContain("[REDACTED]");
  });
});
