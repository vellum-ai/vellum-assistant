import { describe, it, expect } from "bun:test";
import {
  normalizeSlackBlockActions,
  normalizeSlackReactionAdded,
  type SlackBlockActionsPayload,
  type SlackReactionAddedEvent,
} from "./normalize.js";
import type { GatewayConfig } from "../config.js";

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    routingEntries: [],
    unmappedPolicy: "default",
    defaultAssistantId: "ast-1",
    ...overrides,
  } as GatewayConfig;
}

function makeBlockActionsPayload(
  overrides?: Partial<{
    actionId: string;
    actionValue: string;
    userId: string;
    channelId: string;
    messageTs: string;
    triggerId: string;
  }>,
): SlackBlockActionsPayload {
  return {
    type: "block_actions",
    trigger_id: overrides?.triggerId ?? "trigger-123",
    user: { id: overrides?.userId ?? "U123", username: "alice", name: "Alice" },
    channel: { id: overrides?.channelId ?? "C456", name: "general" },
    message: {
      ts: overrides?.messageTs ?? "1234567890.123456",
      text: "Choose an option",
    },
    actions: [
      {
        action_id: overrides?.actionId ?? "approve_btn",
        value: overrides?.actionValue ?? "apr:run1:approve",
        type: "button",
        block_id: "block-1",
        action_ts: "1234567890.654321",
      },
    ],
  };
}

function makeReactionAddedEvent(
  overrides?: Partial<{
    user: string;
    reaction: string;
    channelId: string;
    messageTs: string;
  }>,
): SlackReactionAddedEvent {
  return {
    type: "reaction_added",
    user: overrides?.user ?? "U123",
    reaction: overrides?.reaction ?? "thumbsup",
    item: {
      type: "message",
      channel: overrides?.channelId ?? "C456",
      ts: overrides?.messageTs ?? "1234567890.123456",
    },
  };
}

describe("normalizeSlackBlockActions", () => {
  it("normalizes a block_actions payload with callbackData", () => {
    const config = makeConfig();
    const payload = makeBlockActionsPayload();
    const result = normalizeSlackBlockActions(payload, "env-1", config);

    expect(result).not.toBeNull();
    expect(result!.event.sourceChannel).toBe("slack");
    expect(result!.event.message.callbackData).toBe("apr:run1:approve");
    expect(result!.event.message.callbackQueryId).toBe("trigger-123");
    expect(result!.event.message.content).toBe("apr:run1:approve");
    expect(result!.event.message.conversationExternalId).toBe("C456");
    expect(result!.event.actor.actorExternalId).toBe("U123");
    expect(result!.event.actor.username).toBe("alice");
    expect(result!.event.actor.displayName).toBe("Alice");
    expect(result!.event.message.externalMessageId).toBe(
      "C456:1234567890.123456:1234567890.654321",
    );
    expect(result!.event.source.messageId).toBe("1234567890.123456");
    expect(result!.channel).toBe("C456");
    expect(result!.threadTs).toBe("1234567890.123456");
  });

  it("uses thread root timestamp when message is a threaded reply", () => {
    const config = makeConfig();
    const payload = makeBlockActionsPayload();
    // Simulate a button click on a message that lives inside a thread
    payload.message = {
      ts: "1234567890.999999",
      thread_ts: "1234567890.000001",
      text: "Choose an option",
    };
    const result = normalizeSlackBlockActions(payload, "env-thread", config);

    expect(result).not.toBeNull();
    // threadTs should be the thread root, not the clicked message's ts
    expect(result!.threadTs).toBe("1234567890.000001");
  });

  it("falls back to message ts when no thread_ts is present", () => {
    const config = makeConfig();
    const payload = makeBlockActionsPayload();
    const result = normalizeSlackBlockActions(payload, "env-no-thread", config);

    expect(result).not.toBeNull();
    expect(result!.threadTs).toBe("1234567890.123456");
  });

  it("generates unique externalMessageId per click via action_ts", () => {
    const config = makeConfig();
    const payload1 = makeBlockActionsPayload();
    payload1.actions[0].action_ts = "1000000000.000001";
    const payload2 = makeBlockActionsPayload();
    payload2.actions[0].action_ts = "1000000000.000002";

    const result1 = normalizeSlackBlockActions(payload1, "env-same", config);
    const result2 = normalizeSlackBlockActions(payload2, "env-same", config);

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1!.event.message.externalMessageId).not.toBe(
      result2!.event.message.externalMessageId,
    );
  });

  it("falls back to action_id when value is undefined", () => {
    const config = makeConfig();
    const payload = makeBlockActionsPayload({
      actionValue: undefined as unknown as string,
    });
    payload.actions[0].value = undefined;
    const result = normalizeSlackBlockActions(payload, "env-2", config);

    expect(result).not.toBeNull();
    expect(result!.event.message.callbackData).toBe("approve_btn");
    expect(result!.event.message.content).toBe("approve_btn");
  });

  it("returns null when actions array is empty", () => {
    const config = makeConfig();
    const payload = makeBlockActionsPayload();
    payload.actions = [];
    const result = normalizeSlackBlockActions(payload, "env-3", config);

    expect(result).toBeNull();
  });

  it("returns null when user ID is missing", () => {
    const config = makeConfig();
    const payload = makeBlockActionsPayload();
    payload.user = { id: "", username: "alice" };
    const result = normalizeSlackBlockActions(payload, "env-4", config);

    expect(result).toBeNull();
  });

  it("returns null when channel is missing", () => {
    const config = makeConfig();
    const payload = makeBlockActionsPayload();
    payload.channel = undefined;
    const result = normalizeSlackBlockActions(payload, "env-5", config);

    expect(result).toBeNull();
  });

  it("returns null when routing rejects", () => {
    const config = makeConfig({
      unmappedPolicy: "reject",
      defaultAssistantId: undefined,
    });
    const payload = makeBlockActionsPayload();
    const result = normalizeSlackBlockActions(payload, "env-6", config);

    expect(result).toBeNull();
  });
});

describe("normalizeSlackReactionAdded", () => {
  it("normalizes a reaction_added event with callbackData", () => {
    const config = makeConfig();
    const event = makeReactionAddedEvent();
    const result = normalizeSlackReactionAdded(event, "evt-1", config);

    expect(result).not.toBeNull();
    expect(result!.event.sourceChannel).toBe("slack");
    expect(result!.event.message.callbackData).toBe("reaction:thumbsup");
    expect(result!.event.message.content).toBe("reaction:thumbsup");
    expect(result!.event.message.conversationExternalId).toBe("C456");
    expect(result!.event.message.externalMessageId).toBe(
      "C456:1234567890.123456:thumbsup:U123",
    );
    expect(result!.event.actor.actorExternalId).toBe("U123");
    expect(result!.event.source.messageId).toBe("1234567890.123456");
    expect(result!.channel).toBe("C456");
    expect(result!.threadTs).toBe("1234567890.123456");
  });

  it("returns null when user is missing", () => {
    const config = makeConfig();
    const event = makeReactionAddedEvent({ user: "" });
    const result = normalizeSlackReactionAdded(event, "evt-2", config);

    expect(result).toBeNull();
  });

  it("returns null when item channel is missing", () => {
    const config = makeConfig();
    const event = makeReactionAddedEvent();
    event.item.channel = "";
    const result = normalizeSlackReactionAdded(event, "evt-3", config);

    expect(result).toBeNull();
  });

  it("returns null when item ts is missing", () => {
    const config = makeConfig();
    const event = makeReactionAddedEvent();
    event.item.ts = "";
    const result = normalizeSlackReactionAdded(event, "evt-4", config);

    expect(result).toBeNull();
  });

  it("returns null when routing rejects", () => {
    const config = makeConfig({
      unmappedPolicy: "reject",
      defaultAssistantId: undefined,
    });
    const event = makeReactionAddedEvent();
    const result = normalizeSlackReactionAdded(event, "evt-5", config);

    expect(result).toBeNull();
  });

  it("uses the reaction name in callbackData", () => {
    const config = makeConfig();
    const event = makeReactionAddedEvent({ reaction: "white_check_mark" });
    const result = normalizeSlackReactionAdded(event, "evt-6", config);

    expect(result).not.toBeNull();
    expect(result!.event.message.callbackData).toBe(
      "reaction:white_check_mark",
    );
  });
});
