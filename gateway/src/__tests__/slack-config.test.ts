import { describe, test, expect } from "bun:test";
import { isSlackChannelConfigured, type GatewayConfig } from "../config.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1048576,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    telegramApiBaseUrl: "https://api.telegram.org",
    telegramBotToken: undefined,
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    telegramWebhookSecret: undefined,
    twilioAuthToken: undefined,
    twilioAccountSid: undefined,
    twilioPhoneNumber: undefined,
    ingressPublicBaseUrl: undefined,
    unmappedPolicy: "reject",
    whatsappPhoneNumberId: undefined,
    whatsappAccessToken: undefined,
    whatsappAppSecret: undefined,
    whatsappWebhookVerifyToken: undefined,
    whatsappDeliverAuthBypass: false,
    whatsappTimeoutMs: 15000,
    whatsappMaxRetries: 3,
    whatsappInitialBackoffMs: 1000,
    slackChannelBotToken: undefined,
    slackChannelAppToken: undefined,
    slackDeliverAuthBypass: false,
    trustProxy: false,
    ...overrides,
  } as GatewayConfig;
}

describe("isSlackChannelConfigured", () => {
  test("returns true when both tokens are set", () => {
    const config = makeConfig({
      slackChannelBotToken: "xoxb-test-token",
      slackChannelAppToken: "xapp-test-token",
    });
    expect(isSlackChannelConfigured(config)).toBe(true);
  });

  test("returns false when bot token is missing", () => {
    const config = makeConfig({
      slackChannelBotToken: undefined,
      slackChannelAppToken: "xapp-test-token",
    });
    expect(isSlackChannelConfigured(config)).toBe(false);
  });

  test("returns false when app token is missing", () => {
    const config = makeConfig({
      slackChannelBotToken: "xoxb-test-token",
      slackChannelAppToken: undefined,
    });
    expect(isSlackChannelConfigured(config)).toBe(false);
  });

  test("returns false when both tokens are missing", () => {
    const config = makeConfig({
      slackChannelBotToken: undefined,
      slackChannelAppToken: undefined,
    });
    expect(isSlackChannelConfigured(config)).toBe(false);
  });
});
