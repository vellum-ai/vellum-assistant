import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { callTelegramApi } from "../telegram/api.js";

const originalFetch = globalThis.fetch;

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    telegramBotToken: "test-bot-token",
    telegramWebhookSecret: "test-webhook-secret",
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeBearerToken: undefined,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: false,
    runtimeProxyBearerToken: undefined,
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
    twilioAuthToken: undefined,
    twilioAccountSid: undefined,
    twilioPhoneNumber: undefined,
    smsDeliverAuthBypass: false,
    ingressPublicBaseUrl: "https://example.ngrok.io",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    ...overrides,
  };
}

describe("callTelegramApi transport error redaction", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("redacts bot token from warning logs and thrown error", async () => {
    const tgToken = ["123456789", ":", "ABCDefGHIJklmnopQRSTuvwxyz012345678"].join("");

    globalThis.fetch = mock(async () => {
      const err = new Error("Unable to connect. Is the computer able to access the url?") as Error & {
        path?: string;
        code?: string;
      };
      err.path = `https://api.telegram.org/bot${tgToken}/sendMessage`;
      err.code = "ConnectionRefused";
      throw err;
    }) as unknown as typeof fetch;

    const config = makeConfig({ telegramBotToken: tgToken, telegramMaxRetries: 0 });

    let thrown: Error | null = null;
    try {
      await callTelegramApi(config, "sendMessage", { chat_id: "1", text: "hello" });
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
    const tgToken = ["123456789", ":", "ABCDefGHIJklmnopQRSTuvwxyz012345678"].join("");

    globalThis.fetch = mock(async () => {
      const err = new Error("Connection refused") as Error & {
        path?: string;
        code?: string;
      };
      // Simulate a diagnostic string where the token is preceded by a hyphen
      err.path = `prefix-${tgToken}/sendMessage`;
      err.code = "ConnectionRefused";
      throw err;
    }) as unknown as typeof fetch;

    const config = makeConfig({ telegramBotToken: tgToken, telegramMaxRetries: 0 });

    let thrown: Error | null = null;
    try {
      await callTelegramApi(config, "sendMessage", { chat_id: "1", text: "hello" });
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
    const tgToken = ["123456789", ":", "ABCDefGHIJklmnopQRSTuvwxyz01234567-"].join("");

    globalThis.fetch = mock(async () => {
      const err = new Error("Connection refused") as Error & {
        path?: string;
        code?: string;
      };
      err.path = `https://api.telegram.org/bot${tgToken}/sendMessage`;
      err.code = "ConnectionRefused";
      throw err;
    }) as unknown as typeof fetch;

    const config = makeConfig({ telegramBotToken: tgToken, telegramMaxRetries: 0 });

    let thrown: Error | null = null;
    try {
      await callTelegramApi(config, "sendMessage", { chat_id: "1", text: "hello" });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain(tgToken);
    expect(thrown?.message).toContain("[REDACTED]");
  });
});
