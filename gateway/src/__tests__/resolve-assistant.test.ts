import { describe, test, expect } from "bun:test";
import { LOCAL_ASSISTANT_ID } from "../assistant-id.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { GatewayConfig } from "../config.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    port: 7830,
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

  test("falls back to the local assistant when no explicit match", () => {
    const config = makeConfig();

    const result = resolveAssistant(config, "99001", "55001");
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.assistantId).toBe(LOCAL_ASSISTANT_ID);
      expect(result.routeSource).toBe("default");
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

  test("rejects a no-identity event", () => {
    // Fail-closed: an event with neither a conversation nor an actor id has
    // nothing to route on, so it must reject rather than fall through to the
    // local assistant. This is the only rejection resolveAssistant produces.
    const config = makeConfig();

    for (const [conversationId, actorId] of [
      ["", ""],
      [undefined, undefined],
      ["", undefined],
      [undefined, ""],
    ] as const) {
      const result = resolveAssistant(config, conversationId, actorId);
      expect(isRejection(result)).toBe(true);
      if (isRejection(result)) {
        expect(result.reason).toContain("No routable identity");
      }
    }
  });

  test("still resolves when only one identity is present and matches a route", () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "99001", assistantId: "assistant-a" },
        { type: "actor_id", key: "55001", assistantId: "assistant-b" },
      ],
    });

    // Missing actor, conversation matches.
    const byConversation = resolveAssistant(config, "99001", undefined);
    expect(isRejection(byConversation)).toBe(false);
    if (!isRejection(byConversation)) {
      expect(byConversation.assistantId).toBe("assistant-a");
    }

    // Missing conversation, actor matches.
    const byActor = resolveAssistant(config, undefined, "55001");
    expect(isRejection(byActor)).toBe(false);
    if (!isRejection(byActor)) {
      expect(byActor.assistantId).toBe("assistant-b");
    }
  });

  test("resolves locally when one identity is present but unrouted", () => {
    // A valid-but-unrouted event (real identity, no explicit route) still
    // resolves — only the no-identity case is rejected. Whether it is then
    // admitted is the admission floor's call, not routing's.
    const config = makeConfig();

    const result = resolveAssistant(config, "C-unrouted", undefined);
    expect(isRejection(result)).toBe(false);
    if (!isRejection(result)) {
      expect(result.assistantId).toBe(LOCAL_ASSISTANT_ID);
      expect(result.routeSource).toBe("default");
    }
  });
});
