import { describe, expect, test } from "bun:test";
import {
  normalizeSlackReactionAdded,
  type SlackReactionAddedEvent,
} from "../slack/normalize.js";
import type { GatewayConfig } from "../config.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: "default-assistant",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
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
    unmappedPolicy: "default",
    trustProxy: false,
    ...overrides,
  } as GatewayConfig;
}

function makeReactionEvent(
  overrides?: Partial<SlackReactionAddedEvent>,
): SlackReactionAddedEvent {
  return {
    type: "reaction_added",
    user: "U001",
    reaction: "+1",
    item: {
      type: "message",
      channel: "C123",
      ts: "1234567890.123456",
    },
    event_ts: "1234567890.123457",
    ...overrides,
  };
}

describe("normalizeSlackReactionAdded", () => {
  test("normalizes a reaction_added event with callbackData", () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "C123", assistantId: "ast-1" },
      ],
    });
    const event = makeReactionEvent();
    const result = normalizeSlackReactionAdded(event, "ev-1", config);

    expect(result).not.toBeNull();
    expect(result!.event.sourceChannel).toBe("slack");
    expect(result!.event.message.callbackData).toBe("reaction:+1");
    expect(result!.event.actor.actorExternalId).toBe("U001");
    expect(result!.event.message.conversationExternalId).toBe("C123");
    expect(result!.channel).toBe("C123");
    expect(result!.threadTs).toBe("1234567890.123456");
  });

  test("encodes emoji name in callbackData", () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "C123", assistantId: "ast-1" },
      ],
    });
    const event = makeReactionEvent({ reaction: "white_check_mark" });
    const result = normalizeSlackReactionAdded(event, "ev-2", config);

    expect(result).not.toBeNull();
    expect(result!.event.message.callbackData).toBe(
      "reaction:white_check_mark",
    );
  });

  test("ignores reactions from the bot itself", () => {
    const config = makeConfig();
    const event = makeReactionEvent({ user: "BOT1" });
    const result = normalizeSlackReactionAdded(event, "ev-3", config, "BOT1");

    expect(result).toBeNull();
  });

  test("returns null for unroutable channels without default", () => {
    const config = makeConfig({ defaultAssistantId: undefined });
    const event = makeReactionEvent();
    const result = normalizeSlackReactionAdded(event, "ev-5", config);

    expect(result).toBeNull();
  });

  test("falls back to default assistant for unrouted DM channels", () => {
    const config = makeConfig({
      defaultAssistantId: "default-ast",
      unmappedPolicy: "reject",
    });
    const event = makeReactionEvent({
      item: { type: "message", channel: "D999", ts: "111.222" },
    });
    const result = normalizeSlackReactionAdded(event, "ev-6", config);

    expect(result).not.toBeNull();
    expect(result!.channel).toBe("D999");
  });

  test("does not fall back to default assistant for unrouted public channels", () => {
    const config = makeConfig({
      defaultAssistantId: "default-ast",
      unmappedPolicy: "reject",
    });
    const event = makeReactionEvent({
      item: { type: "message", channel: "C999", ts: "111.222" },
    });
    const result = normalizeSlackReactionAdded(event, "ev-6b", config);

    expect(result).toBeNull();
  });

  test("generates unique externalMessageId including reaction name and user", () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "C123", assistantId: "ast-1" },
      ],
    });
    const event = makeReactionEvent({ reaction: "alarm_clock" });
    const result = normalizeSlackReactionAdded(event, "ev-7", config);

    expect(result).not.toBeNull();
    expect(result!.event.message.externalMessageId).toBe(
      "C123:1234567890.123456:alarm_clock:U001",
    );
  });

  test("two users reacting same emoji produce different externalMessageIds", () => {
    const config = makeConfig({
      routingEntries: [
        { type: "conversation_id", key: "C123", assistantId: "ast-1" },
      ],
    });
    const event1 = makeReactionEvent({ user: "U001" });
    const event2 = makeReactionEvent({ user: "U002" });
    const result1 = normalizeSlackReactionAdded(event1, "ev-8a", config);
    const result2 = normalizeSlackReactionAdded(event2, "ev-8b", config);

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1!.event.message.externalMessageId).not.toBe(
      result2!.event.message.externalMessageId,
    );
  });
});
