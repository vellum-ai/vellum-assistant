import { describe, expect, test } from "bun:test";
import { normalizeSlackReactionAdded } from "../slack/reaction-normalizer.js";
import type { SlackReactionEvent } from "../slack/message-schemas.js";
import type { GatewayConfig } from "../config.js";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
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
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    trustProxy: false,
    ...overrides,
  } as GatewayConfig;
}

function makeReactionEvent(
  overrides?: Partial<SlackReactionEvent>,
): SlackReactionEvent {
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
    expect(result!.event.message.reaction?.emoji).toBe("+1");
    // The sentinel form stays required for mixed-version readers.
    expect(result!.event.message.callbackData).toBe("reaction:+1");
    expect(result!.event.message.reaction?.op).toBe("added");
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
    expect(result!.event.message.reaction?.emoji).toBe("white_check_mark");
    expect(result!.event.message.reaction?.op).toBe("added");
  });

  // Self-authored reactions are now filtered upstream in processEventPayload,
  // not by the normalizer. This test verifies the normalizer no longer
  // performs that check — it normalizes successfully regardless of user.
  test("does not filter reactions by bot user (handled upstream)", () => {
    const config = makeConfig();
    const event = makeReactionEvent({ user: "BOT1" });
    const result = normalizeSlackReactionAdded(event, "ev-3", config);

    expect(result).not.toBeNull();
    expect(result!.event.actor.actorExternalId).toBe("BOT1");
  });

  test("resolves unrouted DM channels to the local assistant", () => {
    const config = makeConfig();
    const event = makeReactionEvent({
      item: { type: "message", channel: "D999", ts: "111.222" },
    });
    const result = normalizeSlackReactionAdded(event, "ev-6", config);

    expect(result).not.toBeNull();
    expect(result!.channel).toBe("D999");
  });

  test("resolves unrouted public channels to the local assistant", () => {
    // Previously dropped here because the unmapped policy rejected them. The
    // gateway now normalizes them and lets the admission floor decide.
    const config = makeConfig();
    const event = makeReactionEvent({
      item: { type: "message", channel: "C999", ts: "111.222" },
    });
    const result = normalizeSlackReactionAdded(event, "ev-6b", config);

    expect(result).not.toBeNull();
    expect(result!.channel).toBe("C999");
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
