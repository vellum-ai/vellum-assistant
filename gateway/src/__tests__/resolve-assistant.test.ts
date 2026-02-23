import { describe, test, expect } from "bun:test";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { GatewayConfig } from "../config.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    telegramBotToken: "tok",
    telegramWebhookSecret: "wh-ver",
    telegramApiBaseUrl: "https://api.telegram.org",
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeBearerToken: undefined,
    runtimeGatewayOriginSecret: undefined,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    runtimeProxyBearerToken: undefined,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    telegramDeliverAuthBypass: false,
    telegramInitialBackoffMs: 1000,
    telegramMaxRetries: 3,
    telegramTimeoutMs: 15000,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: 20971520,
    maxAttachmentConcurrency: 3,
    twilioAuthToken: undefined,
    twilioAccountSid: undefined,
    twilioPhoneNumber: undefined,
    smsDeliverAuthBypass: false,
    ingressPublicBaseUrl: undefined,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    ...overrides,
  };
  if (merged.runtimeGatewayOriginSecret === undefined) {
    merged.runtimeGatewayOriginSecret = merged.runtimeBearerToken;
  }
  return merged;
}

describe("resolveAssistant", () => {
  test("resolves by chat_id match", () => {
    const config = makeConfig({
      routingEntries: [
        { type: "chat_id", key: "99001", assistantId: "assistant-a" },
        { type: "user_id", key: "55001", assistantId: "assistant-b" },
      ],
    });

    const result = resolveAssistant(config, "99001", "55001");
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.assistantId).toBe("assistant-a");
      expect(result.routeSource).toBe("chat_id");
    }
  });

  test("falls back to user_id when chat_id does not match", () => {
    const config = makeConfig({
      routingEntries: [
        { type: "chat_id", key: "99999", assistantId: "assistant-a" },
        { type: "user_id", key: "55001", assistantId: "assistant-b" },
      ],
    });

    const result = resolveAssistant(config, "99001", "55001");
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.assistantId).toBe("assistant-b");
      expect(result.routeSource).toBe("user_id");
    }
  });

  test("falls back to default policy when no explicit match", () => {
    const config = makeConfig({
      unmappedPolicy: "default",
      defaultAssistantId: "assistant-default",
    });

    const result = resolveAssistant(config, "99001", "55001");
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.assistantId).toBe("assistant-default");
      expect(result.routeSource).toBe("default");
    }
  });

  test("rejects when policy is reject and no match", () => {
    const config = makeConfig({
      unmappedPolicy: "reject",
    });

    const result = resolveAssistant(config, "99001", "55001");
    expect(isRejection(result)).toBe(true);
    if (isRejection(result)) {
      expect(result.reason).toContain("No route configured");
    }
  });

  test("chat_id takes priority over user_id for same assistant", () => {
    const config = makeConfig({
      routingEntries: [
        { type: "user_id", key: "55001", assistantId: "assistant-user" },
        { type: "chat_id", key: "99001", assistantId: "assistant-chat" },
      ],
    });

    const result = resolveAssistant(config, "99001", "55001");
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.assistantId).toBe("assistant-chat");
      expect(result.routeSource).toBe("chat_id");
    }
  });

  test("rejects with default policy but no default assistant configured", () => {
    const config = makeConfig({
      unmappedPolicy: "default",
      defaultAssistantId: undefined,
    });

    const result = resolveAssistant(config, "99001", "55001");
    expect(isRejection(result)).toBe(true);
  });
});
