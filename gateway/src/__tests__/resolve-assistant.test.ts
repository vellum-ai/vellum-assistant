import { describe, test, expect } from "bun:test";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { GatewayConfig } from "../config.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

describe("resolveAssistant", () => {
  test("resolves by conversation_id match", () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "99001", assistantId: "assistant-a" },
        { type: "actor_id", key: "55001", assistantId: "assistant-b" },
      ],
    });

    const result = resolveAssistant(config, "99001", "55001");
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.assistantId).toBe("assistant-a");
      expect(result.routeSource).toBe("conversation_id");
    }
  });

  test("falls back to actor_id when conversation_id does not match", () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "99999", assistantId: "assistant-a" },
        { type: "actor_id", key: "55001", assistantId: "assistant-b" },
      ],
    });

    const result = resolveAssistant(config, "99001", "55001");
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.assistantId).toBe("assistant-b");
      expect(result.routeSource).toBe("actor_id");
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

  test("conversation_id takes priority over actor_id for same assistant", () => {
    const config = makeConfig({
      routingEntries: [
        { type: "actor_id", key: "55001", assistantId: "assistant-user" },
        {
          type: "conversation_id",
          key: "99001",
          assistantId: "assistant-chat",
        },
      ],
    });

    const result = resolveAssistant(config, "99001", "55001");
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.assistantId).toBe("assistant-chat");
      expect(result.routeSource).toBe("conversation_id");
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
