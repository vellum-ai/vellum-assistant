import { describe, test, expect } from "bun:test";
import { LOCAL_ASSISTANT_ID } from "../assistant-id.js";
import {
  normalizeSlackAppMention,
  normalizeSlackChannelMessage,
  normalizeSlackDirectMessage,
} from "../slack/message-normalizer.js";
import { normalizeSlackMessageEdit } from "../slack/message-change-normalizer.js";
import type {
  SlackAppMentionEvent,
  SlackChannelMessageEvent,
  SlackDirectMessageEvent,
  SlackMessageChangedEvent,
} from "../slack/message-schemas.js";

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

describe("normalizeSlackAppMention", () => {
  test("normalizes app_mention event with sourceChannel 'slack'", async () => {
    const event = makeEvent();
    const result = await normalizeSlackAppMention(event, "evt-001");

    expect(result).not.toBeNull();
    expect(result!.event.sourceChannel).toBe("slack");
    expect(result!.event.version).toBe("v1");
  });

  test("sets conversationExternalId to event.channel", async () => {
    const event = makeEvent({ channel: "C_MY_CHANNEL" });
    const result = await normalizeSlackAppMention(event, "evt-002");

    expect(result).not.toBeNull();
    expect(result!.event.message.conversationExternalId).toBe("C_MY_CHANNEL");
  });

  test("externalMessageId uses client_msg_id when present", async () => {
    const event = makeEvent({ client_msg_id: "cmid-abc" });
    const result = await normalizeSlackAppMention(event, "evt-003");

    expect(result).not.toBeNull();
    expect(result!.event.message.externalMessageId).toBe("cmid-abc");
  });

  test("externalMessageId falls back to ts when client_msg_id is absent", async () => {
    const event = makeEvent({
      client_msg_id: undefined,
      ts: "1700000000.000100",
    });
    const result = await normalizeSlackAppMention(event, "evt-004");

    expect(result).not.toBeNull();
    expect(result!.event.message.externalMessageId).toBe("1700000000.000100");
  });

  test("renders the bot's mention using the resolved label", async () => {
    const event = makeEvent({ text: "<@U123BOT> hello world" });
    const result = await normalizeSlackAppMention(event, "evt-005", undefined, {
      userLabels: { U123BOT: "vex" },
    });

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("@vex hello world");
  });

  test("renders the bot's mention with the unknown-user fallback when unresolved", async () => {
    const event = makeEvent({ text: "<@U123BOT>" });
    const result = await normalizeSlackAppMention(event, "evt-006");

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("@unknown-user");
  });

  test("renders bot and human mentions side by side", async () => {
    const event = makeEvent({ text: "<@UBOT> <@ULEO> can you check?" });
    const result = await normalizeSlackAppMention(
      event,
      "evt-mention-label",
      undefined,
      { userLabels: { UBOT: "vex", ULEO: "leo" } },
    );

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("@vex @leo can you check?");
  });

  test("renders unresolved user mentions with the unknown-user fallback", async () => {
    const event = makeEvent({ text: "<@UBOT> <@UUNKNOWN> can you check?" });
    const result = await normalizeSlackAppMention(event, "evt-unknown-mention");

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe(
      "@unknown-user @unknown-user can you check?",
    );
  });

  test("thread_ts is preserved in return value", async () => {
    const event = makeEvent({ thread_ts: "1700000000.000050" });
    const result = await normalizeSlackAppMention(event, "evt-007");

    expect(result).not.toBeNull();
    expect(result!.threadTs).toBe("1700000000.000050");
  });

  test("threadTs falls back to ts when thread_ts is not present", async () => {
    const event = makeEvent({ thread_ts: undefined, ts: "1700000000.000100" });
    const result = await normalizeSlackAppMention(event, "evt-008");

    expect(result).not.toBeNull();
    expect(result!.threadTs).toBe("1700000000.000100");
  });

  test("actor.actorExternalId is set to event.user", async () => {
    const event = makeEvent({ user: "U_SENDER_42" });
    const result = await normalizeSlackAppMention(event, "evt-009");

    expect(result).not.toBeNull();
    expect(result!.event.actor.actorExternalId).toBe("U_SENDER_42");
  });

  test("channel field is set in return value", async () => {
    const event = makeEvent({ channel: "C_RETURN_CHAN" });
    const result = await normalizeSlackAppMention(event, "evt-010");

    expect(result).not.toBeNull();
    expect(result!.channel).toBe("C_RETURN_CHAN");
  });

  test("source.updateId is set to eventId", async () => {
    const event = makeEvent();
    const result = await normalizeSlackAppMention(event, "my-event-id");

    expect(result).not.toBeNull();
    expect(result!.event.source.updateId).toBe("my-event-id");
  });

  test("resolves an unrouted mention to the local assistant", async () => {
    const event = makeEvent();
    const result = await normalizeSlackAppMention(event, "evt-011");

    expect(result).not.toBeNull();
    expect(result!.routing.assistantId).toBe(LOCAL_ASSISTANT_ID);
  });

  test("raw event is included in the result", async () => {
    const event = makeEvent();
    const result = await normalizeSlackAppMention(event, "evt-012");

    expect(result).not.toBeNull();
    expect(result!.event.raw).toEqual(
      event as unknown as Record<string, unknown>,
    );
  });
});

function makeDirectMessageEvent(
  overrides: Partial<SlackDirectMessageEvent> = {},
): SlackDirectMessageEvent {
  return {
    type: "message",
    user: "U_USER123",
    text: "hello world",
    ts: "1700000000.000100",
    channel: "D_DIRECT1",
    channel_type: "im",
    ...overrides,
  };
}

function makeChannelMessageEvent(
  overrides: Partial<SlackChannelMessageEvent> = {},
): SlackChannelMessageEvent {
  return {
    type: "message",
    user: "U_USER123",
    text: "hello world",
    ts: "1700000000.000100",
    channel: "C_CHANNEL1",
    channel_type: "channel",
    ...overrides,
  };
}

describe("Slack inbound mention rendering", () => {
  test("direct messages render mentions without stripping the bot mention", () => {
    const event = makeDirectMessageEvent({
      text: "<@UBOT> <@ULEO> hello",
    });
    const result = normalizeSlackDirectMessage(
      event,
      "evt-dm-render",
      undefined,
      { userLabels: { UBOT: "assistant", ULEO: "leo" } },
    );

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("@assistant @leo hello");
    expect(result!.event.actor.actorExternalId).toBe("U_USER123");
    expect(result!.event.message.conversationExternalId).toBe("D_DIRECT1");
  });

  test("channel messages render bot and human mentions inline", () => {
    const event = makeChannelMessageEvent({
      text: "<@UBOT> <@ULEO> hello",
    });
    const result = normalizeSlackChannelMessage(
      event,
      "evt-channel-render",
      undefined,
      { userLabels: { UBOT: "vex", ULEO: "leo" } },
    );

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("@vex @leo hello");
    expect(result!.event.actor.actorExternalId).toBe("U_USER123");
    expect(result!.event.message.conversationExternalId).toBe("C_CHANNEL1");
  });

  test("channel messages render with unknown-user fallback when bot label is missing", () => {
    const event = makeChannelMessageEvent({
      text: "<@UBOT> <@ULEO> hello",
    });
    const result = normalizeSlackChannelMessage(
      event,
      "evt-channel-fallback-render",
      undefined,
      { userLabels: { ULEO: "leo" } },
    );

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("@unknown-user @leo hello");
  });

  test("message edits render bot and human mentions and preserve edit metadata", () => {
    const event = makeMessageChangedEvent({
      message: {
        user: "U_USER123",
        text: "<@UBOT> <@ULEO> edited",
        ts: "1700000000.000100",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-edit-render", {
      userLabels: { UBOT: "vex", ULEO: "leo" },
    });

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("@vex @leo edited");
    expect(result!.event.message.isEdit).toBe(true);
    expect(result!.event.message.externalMessageId).toBe("evt-edit-render");
    expect(result!.event.source.messageId).toBe("1700000000.000100");
    expect(result!.event.actor.actorExternalId).toBe("U_USER123");
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
    const event = makeMessageChangedEvent();
    const result = normalizeSlackMessageEdit(event, "evt-100");

    expect(result).not.toBeNull();
    expect(result!.event.sourceChannel).toBe("slack");
    expect(result!.event.message.isEdit).toBe(true);
    expect(result!.event.message.content).toBe("edited hello world");
  });

  test("uses eventId as externalMessageId for edit dedup", () => {
    const event = makeMessageChangedEvent();
    const result = normalizeSlackMessageEdit(event, "evt-101");

    expect(result).not.toBeNull();
    // Each edit gets a unique externalMessageId (eventId) so successive edits aren't deduped
    expect(result!.event.message.externalMessageId).toBe("evt-101");
    // The original message ts is in source.messageId for runtime correlation
    expect(result!.event.source.messageId).toBe("1700000000.000100");
  });

  test("returns null when edited message has no user", () => {
    const event = makeMessageChangedEvent({
      message: { text: "no user", ts: "1700000000.000100" },
    });
    const result = normalizeSlackMessageEdit(event, "evt-102");

    expect(result).toBeNull();
  });

  // Self-authored edits are now filtered upstream in processEventPayload,
  // not by the normalizer. This test verifies the normalizer no longer
  // performs that check — an edit from the bot's own user ID normalizes
  // successfully. The pipeline filter is tested in socket-mode tests.
  test("does not filter edits by bot user (handled upstream)", () => {
    const event = makeMessageChangedEvent({
      message: {
        user: "U_BOT",
        text: "bot edited",
        ts: "1700000000.000100",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-103");

    expect(result).not.toBeNull();
    expect(result!.event.actor.actorExternalId).toBe("U_BOT");
  });

  test("renders bot mention in edited text", () => {
    const event = makeMessageChangedEvent({
      message: {
        user: "U_USER123",
        text: "<@U123BOT> edited content",
        ts: "1700000000.000100",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-104", {
      userLabels: { U123BOT: "vex" },
    });

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toBe("@vex edited content");
  });

  test("sets actor.actorExternalId from edited message user", () => {
    const event = makeMessageChangedEvent({
      message: {
        user: "U_EDITOR",
        text: "edited",
        ts: "1700000000.000100",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-105");

    expect(result).not.toBeNull();
    expect(result!.event.actor.actorExternalId).toBe("U_EDITOR");
  });

  test("threadTs uses edited message thread_ts when present", () => {
    const event = makeMessageChangedEvent({
      message: {
        user: "U_USER123",
        text: "edited",
        ts: "1700000000.000100",
        thread_ts: "1700000000.000050",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-106");

    expect(result).not.toBeNull();
    expect(result!.threadTs).toBe("1700000000.000050");
  });

  test("threadTs falls back to edited message ts when no thread_ts", () => {
    const event = makeMessageChangedEvent();
    const result = normalizeSlackMessageEdit(event, "evt-107");

    expect(result).not.toBeNull();
    // Falls back to edited.ts (not the wrapper event.ts)
    expect(result!.threadTs).toBe("1700000000.000100");
  });

  test("DM edit without thread_ts omits threadTs", () => {
    const event = makeMessageChangedEvent({ channel_type: "im" });
    const result = normalizeSlackMessageEdit(event, "evt-dm-edit-1");

    expect(result).not.toBeNull();
    expect(result!.threadTs).toBeUndefined();
  });

  test("DM edit with thread_ts preserves threadTs", () => {
    const event = makeMessageChangedEvent({
      channel_type: "im",
      message: {
        user: "U_USER123",
        text: "edited hello world",
        ts: "1700000000.000100",
        thread_ts: "1700000000.000050",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-dm-edit-2");

    expect(result).not.toBeNull();
    expect(result!.threadTs).toBe("1700000000.000050");
  });

  test("DM edits use default assistant when channel is not in routing table", () => {
    const event = makeMessageChangedEvent({ channel_type: "im" });
    const result = normalizeSlackMessageEdit(event, "evt-108");

    expect(result).not.toBeNull();
    expect(result!.event.message.isEdit).toBe(true);
  });

  test("resolves an unrouted non-DM edit to the local assistant", () => {
    const event = makeMessageChangedEvent({ channel_type: "channel" });
    const result = normalizeSlackMessageEdit(event, "evt-109");

    expect(result).not.toBeNull();
    expect(result!.routing.assistantId).toBe(LOCAL_ASSISTANT_ID);
  });

  test("sets chatType to channel for non-DM edits", () => {
    const event = makeMessageChangedEvent({ channel_type: "channel" });
    const result = normalizeSlackMessageEdit(event, "evt-110");

    expect(result).not.toBeNull();
    expect(result!.event.source.chatType).toBe("channel");
  });

  test("does not set chatType for DM edits", () => {
    const event = makeMessageChangedEvent({ channel_type: "im" });
    const result = normalizeSlackMessageEdit(event, "evt-111");

    expect(result).not.toBeNull();
    expect(result!.event.source.chatType).toBeUndefined();
  });

  test("returns null for metadata-only mutation on a never-edited message", () => {
    const event = makeMessageChangedEvent({
      message: {
        user: "U_USER123",
        text: "<@UBOT> can you take a look",
        ts: "1700000000.000100",
      },
      previous_message: {
        user: "U_USER123",
        text: "<@UBOT> can you take a look",
        ts: "1700000000.000100",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-metadata-only-1");

    expect(result).toBeNull();
  });

  test("returns null for metadata-only mutation on an already-edited message", () => {
    const event = makeMessageChangedEvent({
      message: {
        user: "U_USER123",
        text: "<@UBOT> can you take a look",
        ts: "1700000000.000100",
        edited: { user: "U_USER123", ts: "1700000000.000150" },
      },
      previous_message: {
        user: "U_USER123",
        text: "<@UBOT> can you take a look",
        ts: "1700000000.000100",
        edited: { user: "U_USER123", ts: "1700000000.000150" },
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-metadata-only-2");

    expect(result).toBeNull();
  });

  test("returns null for metadata-only mutation in a DM", () => {
    const event = makeMessageChangedEvent({
      channel: "D_DM_CHANNEL",
      channel_type: "im",
      message: {
        user: "U_USER123",
        text: "hey, free for a quick sync?",
        ts: "1700000000.000100",
      },
      previous_message: {
        user: "U_USER123",
        text: "hey, free for a quick sync?",
        ts: "1700000000.000100",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-metadata-only-dm");

    expect(result).toBeNull();
  });

  test("forwards first user edit when message.edited becomes set", () => {
    const event = makeMessageChangedEvent({
      message: {
        user: "U_USER123",
        text: "<@UBOT> can you take another look",
        ts: "1700000000.000100",
        edited: { user: "U_USER123", ts: "1700000000.000200" },
      },
      previous_message: {
        user: "U_USER123",
        text: "<@UBOT> can you take a look",
        ts: "1700000000.000100",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-real-edit-1");

    expect(result).not.toBeNull();
    expect(result!.event.message.content).toContain(
      "can you take another look",
    );
    expect(result!.event.message.isEdit).toBe(true);
  });

  test("forwards rich-text-only edit when text is identical but edited.ts changes", () => {
    const event = makeMessageChangedEvent({
      message: {
        user: "U_USER123",
        text: "<@UBOT> can you take a look",
        ts: "1700000000.000100",
        edited: { user: "U_USER123", ts: "1700000000.000200" },
      },
      previous_message: {
        user: "U_USER123",
        text: "<@UBOT> can you take a look",
        ts: "1700000000.000100",
      },
    });
    const result = normalizeSlackMessageEdit(event, "evt-rich-text-edit");

    expect(result).not.toBeNull();
    expect(result!.event.message.isEdit).toBe(true);
  });

  test("forwards edit when previous_message is missing (cannot prove no-op)", () => {
    const event = makeMessageChangedEvent();
    expect(event.previous_message).toBeUndefined();

    const result = normalizeSlackMessageEdit(event, "evt-no-prev");
    expect(result).not.toBeNull();
    expect(result!.event.message.isEdit).toBe(true);
  });
});
