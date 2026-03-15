import { describe, test, expect } from "bun:test";
import {
  stripBotMention,
  normalizeSlackAppMention,
  normalizeSlackMessageEdit,
  type SlackAppMentionEvent,
  type SlackMessageChangedEvent,
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

function makeEvent(
  overrides: Partial<SlackAppMentionEvent> = {},
): SlackAppMentionEvent {
  return {
    type: "app_mention",
    user: "U_USER123",
    text: "<@U123BOT> hello world",
    ts: "1700000000.000100",
    channel: "C_CHANNEL1",
    ...overrides,
  };
}

describe("stripBotMention", () => {
  test("strips a single leading bot mention", () => {
    expect(stripBotMention("<@U123BOT> hello world")).toBe("hello world");
  });

  test("strips multiple leading bot mentions", () => {
    expect(stripBotMention("<@U123BOT> <@U456OTHER> hello")).toBe("hello");
  });

  test("falls back to original text when stripping produces empty string", () => {
    expect(stripBotMention("<@U123BOT>")).toBe("<@U123BOT>");
  });

  test("falls back to original trimmed text when stripping produces whitespace only", () => {
    expect(stripBotMention("<@U123BOT>   ")).toBe("<@U123BOT>");
  });

  test("returns text unchanged when no leading mention", () => {
    expect(stripBotMention("hello world")).toBe("hello world");
  });

  test("does not strip mid-text mentions", () => {
    expect(stripBotMention("hello <@U123BOT> world")).toBe(
      "hello <@U123BOT> world",
    );
  });
});

describe("normalizeSlackAppMention", () => {
  test("normalizes app_mention event with sourceChannel 'slack'", async () => {
    const config = makeConfig();
    const event = makeEvent();
    const result = await normalizeSlackAppMention(event, "evt-001", config);

    expect(result).not.toBeNull();
    expect(result!.event.sourceChannel).toBe("slack");
    expect(result!.event.version).toBe("v1");
  });

  test("sets conversationExternalId to event.channel", async () => {
    const config = makeConfig();
    const event = makeEvent({ channel: "C_MY_CHANNEL" });
    const result = await normalizeSlackAppMention(event, "evt-002", config);

    expect(result).not.toBeNull();
    expect(result!.event.message.conversationExternalId).toBe("C_MY_CHANNEL");
  });

  test("externalMessageId uses client_msg_id when present", async () => {
    const config = makeConfig();
    const event = makeEvent({ client_msg_id: "cmid-abc" });
    const result = await normalizeSlackAppMention(event, "evt-003", config);

    expect(result).not.toBeNull();
    expect(result!.event.message.externalMessageId).toBe("cmid-abc");
  });

  test("externalMessageId falls back to ts when client_msg_id is absent", async () => {
    const config = makeConfig();
    const event = makeEvent({
      client_msg_id: undefined,
      ts: "1700000000.000100",
    });
    const result = await normalizeSlackAppMention(event, "evt-004", config);

    expect(result).not.toBeNull();
    expect(result!.event.message.externalMessageId).toBe("1700000000.000100");
  });

  test("mention stripping: '<@U123BOT> hello world' becomes 'hello world'", async () => {
    const config = makeConfig();
    const event = makeEvent({ text: "<@U123BOT> hello world" });
    const result = await normalizeSlackAppMention(event, "evt-005", config);

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("hello world");
  });

  test("mention stripping with empty result falls back to original text", async () => {
    const config = makeConfig();
    const event = makeEvent({ text: "<@U123BOT>" });
    const result = await normalizeSlackAppMention(event, "evt-006", config);

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("<@U123BOT>");
  });

  test("thread_ts is preserved in return value", async () => {
    const config = makeConfig();
    const event = makeEvent({ thread_ts: "1700000000.000050" });
    const result = await normalizeSlackAppMention(event, "evt-007", config);

    expect(result).not.toBeNull();
    expect(result!.threadTs).toBe("1700000000.000050");
  });

  test("threadTs falls back to ts when thread_ts is not present", async () => {
    const config = makeConfig();
    const event = makeEvent({ thread_ts: undefined, ts: "1700000000.000100" });
    const result = await normalizeSlackAppMention(event, "evt-008", config);

    expect(result).not.toBeNull();
    expect(result!.threadTs).toBe("1700000000.000100");
  });

  test("actor.actorExternalId is set to event.user", async () => {
    const config = makeConfig();
    const event = makeEvent({ user: "U_SENDER_42" });
    const result = await normalizeSlackAppMention(event, "evt-009", config);

    expect(result).not.toBeNull();
    expect(result!.event.actor.actorExternalId).toBe("U_SENDER_42");
  });

  test("channel field is set in return value", async () => {
    const config = makeConfig();
    const event = makeEvent({ channel: "C_RETURN_CHAN" });
    const result = await normalizeSlackAppMention(event, "evt-010", config);

    expect(result).not.toBeNull();
    expect(result!.channel).toBe("C_RETURN_CHAN");
  });

  test("source.updateId is set to eventId", async () => {
    const config = makeConfig();
    const event = makeEvent();
    const result = await normalizeSlackAppMention(event, "my-event-id", config);

    expect(result).not.toBeNull();
    expect(result!.event.source.updateId).toBe("my-event-id");
  });

  test("returns null when routing rejects the event", async () => {
    const config = makeConfig({
      unmappedPolicy: "reject",
      defaultAssistantId: undefined,
      routingEntries: [],
    });
    const event = makeEvent();
    const result = await normalizeSlackAppMention(event, "evt-011", config);

    expect(result).toBeNull();
  });

  test("raw event is included in the result", async () => {
    const config = makeConfig();
    const event = makeEvent();
    const result = await normalizeSlackAppMention(event, "evt-012", config);

    expect(result).not.toBeNull();
    expect(result!.event.raw).toEqual(
      event as unknown as Record<string, unknown>,
    );
  });
});

function makeMessageChangedEvent(
  overrides: Partial<SlackMessageChangedEvent> = {},
): SlackMessageChangedEvent {
  return {
    type: "message",
    subtype: "message_changed",
    channel: "C_CHANNEL1",
    ts: "1700000000.000200",
    message: {
      user: "U_USER123",
      text: "edited hello world",
      ts: "1700000000.000100",
    },
    ...overrides,
  };
}

describe("normalizeSlackMessageEdit", () => {
  test("normalizes message_changed event with isEdit: true", () => {
    const config = makeConfig();
    const event = makeMessageChangedEvent();
    const result = normalizeSlackMessageEdit(event, "evt-100", config);

    expect(result).not.toBeNull();
    expect(result!.event.sourceChannel).toBe("slack");
    expect(result!.event.message.isEdit).toBe(true);
    expect(result!.event.message.content).toBe("edited hello world");
  });

  test("uses eventId as externalMessageId for edit dedup", () => {
    const config = makeConfig();
    const event = makeMessageChangedEvent();
    const result = normalizeSlackMessageEdit(event, "evt-101", config);

    expect(result).not.toBeNull();
    // Each edit gets a unique externalMessageId (eventId) so successive edits aren't deduped
    expect(result!.event.message.externalMessageId).toBe("evt-101");
    // The original message ts is in source.messageId for runtime correlation
    expect(result!.event.source.messageId).toBe("1700000000.000100");
  });

  test("returns null when edited message has no user", () => {
    const config = makeConfig();
    const event = makeMessageChangedEvent({
      message: { text: "no user", ts: "1700000000.000100" },
    });
    const result = normalizeSlackMessageEdit(event, "evt-102", config);

    expect(result).toBeNull();
  });

  test("returns null when edit is from the bot itself", () => {
    const config = makeConfig();
    const event = makeMessageChangedEvent({
      message: {
        user: "U_BOT",
        text: "bot edited",
        ts: "1700000000.000100",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-103", config, "U_BOT");

    expect(result).toBeNull();
  });

  test("strips bot mention from edited text", () => {
    const config = makeConfig();
    const event = makeMessageChangedEvent({
      message: {
        user: "U_USER123",
        text: "<@U123BOT> edited content",
        ts: "1700000000.000100",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-104", config);

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("edited content");
  });

  test("sets actor.actorExternalId from edited message user", () => {
    const config = makeConfig();
    const event = makeMessageChangedEvent({
      message: {
        user: "U_EDITOR",
        text: "edited",
        ts: "1700000000.000100",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-105", config);

    expect(result).not.toBeNull();
    expect(result!.event.actor.actorExternalId).toBe("U_EDITOR");
  });

  test("threadTs uses edited message thread_ts when present", () => {
    const config = makeConfig();
    const event = makeMessageChangedEvent({
      message: {
        user: "U_USER123",
        text: "edited",
        ts: "1700000000.000100",
        thread_ts: "1700000000.000050",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-106", config);

    expect(result).not.toBeNull();
    expect(result!.threadTs).toBe("1700000000.000050");
  });

  test("threadTs falls back to edited message ts when no thread_ts", () => {
    const config = makeConfig();
    const event = makeMessageChangedEvent();
    const result = normalizeSlackMessageEdit(event, "evt-107", config);

    expect(result).not.toBeNull();
    // Falls back to edited.ts (not the wrapper event.ts)
    expect(result!.threadTs).toBe("1700000000.000100");
  });

  test("DM edits use default assistant when channel is not in routing table", () => {
    const config = makeConfig({
      unmappedPolicy: "reject",
      defaultAssistantId: "default-assistant",
      routingEntries: [],
    });
    const event = makeMessageChangedEvent({ channel_type: "im" });
    const result = normalizeSlackMessageEdit(event, "evt-108", config);

    expect(result).not.toBeNull();
    expect(result!.event.message.isEdit).toBe(true);
  });

  test("returns null when routing rejects non-DM event", () => {
    const config = makeConfig({
      unmappedPolicy: "reject",
      defaultAssistantId: undefined,
      routingEntries: [],
    });
    const event = makeMessageChangedEvent({ channel_type: "channel" });
    const result = normalizeSlackMessageEdit(event, "evt-109", config);

    expect(result).toBeNull();
  });

  test("sets chatType to channel for non-DM edits", () => {
    const config = makeConfig();
    const event = makeMessageChangedEvent({ channel_type: "channel" });
    const result = normalizeSlackMessageEdit(event, "evt-110", config);

    expect(result).not.toBeNull();
    expect(result!.event.source.chatType).toBe("channel");
  });

  test("does not set chatType for DM edits", () => {
    const config = makeConfig();
    const event = makeMessageChangedEvent({ channel_type: "im" });
    const result = normalizeSlackMessageEdit(event, "evt-111", config);

    expect(result).not.toBeNull();
    expect(result!.event.source.chatType).toBeUndefined();
  });
});
