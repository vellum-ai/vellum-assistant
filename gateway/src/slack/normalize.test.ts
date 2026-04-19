import { describe, it, expect } from "bun:test";
import {
  normalizeSlackBlockActions,
  normalizeSlackReactionAdded,
  normalizeSlackDirectMessage,
  normalizeSlackChannelMessage,
  normalizeSlackAppMention,
  normalizeSlackMessageEdit,
  type SlackBlockActionsPayload,
  type SlackReactionAddedEvent,
  type SlackDirectMessageEvent,
  type SlackChannelMessageEvent,
  type SlackAppMentionEvent,
  type SlackMessageChangedEvent,
  type SlackFile,
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

describe("DM threading", () => {
  it("non-threaded DM has no threadTs", () => {
    const config = makeConfig();
    const event = makeDmEvent();
    const result = normalizeSlackDirectMessage(event, "evt-dm-1", config);

    expect(result).not.toBeNull();
    expect(result!.threadTs).toBeUndefined();
  });

  it("threaded DM preserves threadTs", () => {
    const config = makeConfig();
    const event = makeDmEvent({ thread_ts: "1700000000.000050" });
    const result = normalizeSlackDirectMessage(event, "evt-dm-2", config);

    expect(result).not.toBeNull();
    expect(result!.threadTs).toBe("1700000000.000050");
  });
});

// --- Attachment extraction tests ---

function makeSlackFile(overrides?: Partial<SlackFile>): SlackFile {
  return {
    id: "F001",
    name: "photo.png",
    mimetype: "image/png",
    size: 12345,
    url_private_download: "https://files.slack.com/download/photo.png",
    url_private: "https://files.slack.com/files/photo.png",
    ...overrides,
  };
}

function makeDmEvent(
  overrides?: Partial<SlackDirectMessageEvent>,
): SlackDirectMessageEvent {
  return {
    type: "message",
    user: "U123",
    text: "hello",
    ts: "1234567890.123456",
    channel: "D789",
    channel_type: "im",
    ...overrides,
  };
}

function makeChannelEvent(
  overrides?: Partial<SlackChannelMessageEvent>,
): SlackChannelMessageEvent {
  return {
    type: "message",
    user: "U123",
    text: "hello",
    ts: "1234567890.123456",
    channel: "C456",
    channel_type: "channel",
    ...overrides,
  };
}

function makeAppMentionEvent(
  overrides?: Partial<SlackAppMentionEvent>,
): SlackAppMentionEvent {
  return {
    type: "app_mention",
    user: "U123",
    text: "<@UBOT> hello",
    ts: "1234567890.123456",
    channel: "C456",
    ...overrides,
  };
}

describe("attachment extraction in normalize functions", () => {
  describe("normalizeSlackDirectMessage", () => {
    it("populates attachments with type 'image' for image files", () => {
      const config = makeConfig();
      const event = makeDmEvent({
        files: [
          makeSlackFile({ id: "F001", mimetype: "image/png", name: "photo.png" }),
          makeSlackFile({ id: "F002", mimetype: "image/jpeg", name: "pic.jpg" }),
        ],
      });
      const result = normalizeSlackDirectMessage(event, "evt-1", config);

      expect(result).not.toBeNull();
      expect(result!.event.message.attachments).toHaveLength(2);
      expect(result!.event.message.attachments![0]).toEqual({
        type: "image",
        fileId: "F001",
        fileName: "photo.png",
        mimeType: "image/png",
        fileSize: 12345,
      });
      expect(result!.event.message.attachments![1]).toEqual({
        type: "image",
        fileId: "F002",
        fileName: "pic.jpg",
        mimeType: "image/jpeg",
        fileSize: 12345,
      });

      // slackFiles map should be populated
      expect(result!.slackFiles).toBeDefined();
      expect(result!.slackFiles!.size).toBe(2);
      expect(result!.slackFiles!.get("F001")!.id).toBe("F001");
      expect(result!.slackFiles!.get("F002")!.id).toBe("F002");
    });

    it("populates attachments with type 'document' for non-image files", () => {
      const config = makeConfig();
      const event = makeDmEvent({
        files: [
          makeSlackFile({
            id: "F003",
            mimetype: "application/pdf",
            name: "doc.pdf",
            size: 99999,
          }),
        ],
      });
      const result = normalizeSlackDirectMessage(event, "evt-2", config);

      expect(result).not.toBeNull();
      expect(result!.event.message.attachments).toHaveLength(1);
      expect(result!.event.message.attachments![0]).toEqual({
        type: "document",
        fileId: "F003",
        fileName: "doc.pdf",
        mimeType: "application/pdf",
        fileSize: 99999,
      });
    });

    it("filters out files missing download URLs", () => {
      const config = makeConfig();
      const event = makeDmEvent({
        files: [
          makeSlackFile({ id: "F004" }),
          makeSlackFile({
            id: "F005",
            url_private_download: undefined,
            url_private: undefined,
          }),
        ],
      });
      const result = normalizeSlackDirectMessage(event, "evt-3", config);

      expect(result).not.toBeNull();
      // Only F004 has download URLs
      expect(result!.event.message.attachments).toHaveLength(1);
      expect(result!.event.message.attachments![0].fileId).toBe("F004");
      expect(result!.slackFiles!.size).toBe(1);
      expect(result!.slackFiles!.has("F005")).toBe(false);
    });

    it("omits attachments field when files is empty", () => {
      const config = makeConfig();
      const event = makeDmEvent({ files: [] });
      const result = normalizeSlackDirectMessage(event, "evt-4", config);

      expect(result).not.toBeNull();
      expect(result!.event.message.attachments).toBeUndefined();
      expect(result!.slackFiles).toBeUndefined();
    });

    it("omits attachments field when files is undefined", () => {
      const config = makeConfig();
      const event = makeDmEvent();
      const result = normalizeSlackDirectMessage(event, "evt-5", config);

      expect(result).not.toBeNull();
      expect(result!.event.message.attachments).toBeUndefined();
      expect(result!.slackFiles).toBeUndefined();
    });
  });

  describe("normalizeSlackChannelMessage", () => {
    it("populates attachments for channel messages with files", () => {
      const config = makeConfig();
      const event = makeChannelEvent({
        files: [
          makeSlackFile({ id: "F010", mimetype: "image/gif", name: "anim.gif" }),
        ],
      });
      const result = normalizeSlackChannelMessage(event, "evt-ch-1", config);

      expect(result).not.toBeNull();
      expect(result!.event.message.attachments).toHaveLength(1);
      expect(result!.event.message.attachments![0]).toEqual({
        type: "image",
        fileId: "F010",
        fileName: "anim.gif",
        mimeType: "image/gif",
        fileSize: 12345,
      });
      expect(result!.slackFiles).toBeDefined();
      expect(result!.slackFiles!.get("F010")!.name).toBe("anim.gif");
    });
  });

  describe("file_share subtype handling", () => {
    describe("normalizeSlackDirectMessage", () => {
      it("normalizes DM with file_share subtype and files", () => {
        const config = makeConfig();
        const event = makeDmEvent({
          subtype: "file_share",
          files: [
            makeSlackFile({
              id: "F030",
              mimetype: "image/png",
              name: "screenshot.png",
            }),
          ],
        });
        const result = normalizeSlackDirectMessage(event, "evt-fs-1", config);

        expect(result).not.toBeNull();
        expect(result!.event.message.attachments).toHaveLength(1);
        expect(result!.event.message.attachments![0].fileId).toBe("F030");
        expect(result!.event.message.attachments![0].type).toBe("image");
        expect(result!.slackFiles).toBeDefined();
        expect(result!.slackFiles!.get("F030")!.id).toBe("F030");
      });

      it("normalizes DM with file_share subtype without files", () => {
        const config = makeConfig();
        const event = makeDmEvent({ subtype: "file_share" });
        const result = normalizeSlackDirectMessage(event, "evt-fs-2", config);

        expect(result).not.toBeNull();
        expect(result!.event.message.content).toBe("hello");
        expect(result!.event.message.attachments).toBeUndefined();
      });

      it("drops DM with bot_message subtype", () => {
        const config = makeConfig();
        const event = makeDmEvent({ subtype: "bot_message" });
        const result = normalizeSlackDirectMessage(event, "evt-fs-3", config);

        expect(result).toBeNull();
      });
    });

    describe("normalizeSlackChannelMessage", () => {
      it("normalizes channel message with file_share subtype and files", () => {
        const config = makeConfig();
        const event = makeChannelEvent({
          subtype: "file_share",
          files: [
            makeSlackFile({
              id: "F031",
              mimetype: "image/jpeg",
              name: "photo.jpg",
            }),
          ],
        });
        const result = normalizeSlackChannelMessage(
          event,
          "evt-fs-4",
          config,
        );

        expect(result).not.toBeNull();
        expect(result!.event.message.attachments).toHaveLength(1);
        expect(result!.event.message.attachments![0].fileId).toBe("F031");
        expect(result!.event.message.attachments![0].type).toBe("image");
        expect(result!.slackFiles).toBeDefined();
      });

      it("normalizes channel message with file_share subtype without files", () => {
        const config = makeConfig();
        const event = makeChannelEvent({ subtype: "file_share" });
        const result = normalizeSlackChannelMessage(
          event,
          "evt-fs-5",
          config,
        );

        expect(result).not.toBeNull();
        expect(result!.event.message.content).toBe("hello");
        expect(result!.event.message.attachments).toBeUndefined();
      });

      it("drops channel message with bot_message subtype", () => {
        const config = makeConfig();
        const event = makeChannelEvent({ subtype: "bot_message" });
        const result = normalizeSlackChannelMessage(
          event,
          "evt-fs-6",
          config,
        );

        expect(result).toBeNull();
      });
    });
  });

  describe("normalizeSlackAppMention", () => {
    it("populates attachments for app mention events with files", () => {
      const config = makeConfig();
      const event = makeAppMentionEvent({
        files: [
          makeSlackFile({
            id: "F020",
            mimetype: "text/plain",
            name: "notes.txt",
            size: 500,
          }),
        ],
      });
      const result = normalizeSlackAppMention(event, "evt-am-1", config);

      expect(result).not.toBeNull();
      expect(result!.event.message.attachments).toHaveLength(1);
      expect(result!.event.message.attachments![0]).toEqual({
        type: "document",
        fileId: "F020",
        fileName: "notes.txt",
        mimeType: "text/plain",
        fileSize: 500,
      });
      expect(result!.slackFiles).toBeDefined();
      expect(result!.slackFiles!.get("F020")!.id).toBe("F020");
    });
  });
});

// --- source.threadId propagation ---
//
// Asserts that PR 2's new `source.threadId` field is populated on every
// Slack normalizer that has thread info, and absent for top-level messages
// without a thread.

function makeMessageChangedEvent(
  overrides?: Partial<{
    channel: string;
    channelType: "im" | "channel" | "group" | "mpim";
    ts: string;
    messageTs: string;
    user: string;
    text: string;
    threadTs: string;
  }>,
): SlackMessageChangedEvent {
  return {
    type: "message",
    subtype: "message_changed",
    channel: overrides?.channel ?? "C456",
    channel_type: overrides?.channelType ?? "channel",
    ts: overrides?.ts ?? "1700000001.000000",
    message: {
      user: overrides?.user ?? "U123",
      text: overrides?.text ?? "edited content",
      ts: overrides?.messageTs ?? "1700000000.000000",
      ...(overrides?.threadTs ? { thread_ts: overrides.threadTs } : {}),
    },
  };
}

describe("source.threadId propagation", () => {
  describe("normalizeSlackDirectMessage", () => {
    it("populates source.threadId when thread_ts is present", () => {
      const config = makeConfig();
      const event = makeDmEvent({ thread_ts: "1700000000.111111" });
      const result = normalizeSlackDirectMessage(event, "evt-tid-1", config);

      expect(result).not.toBeNull();
      expect(result!.event.source.threadId).toBe("1700000000.111111");
    });

    it("omits source.threadId when thread_ts is absent", () => {
      const config = makeConfig();
      const event = makeDmEvent();
      const result = normalizeSlackDirectMessage(event, "evt-tid-2", config);

      expect(result).not.toBeNull();
      expect(result!.event.source.threadId).toBeUndefined();
    });
  });

  describe("normalizeSlackChannelMessage", () => {
    it("populates source.threadId when thread_ts is present", () => {
      const config = makeConfig();
      const event = makeChannelEvent({ thread_ts: "1700000000.222222" });
      const result = normalizeSlackChannelMessage(event, "evt-tid-3", config);

      expect(result).not.toBeNull();
      expect(result!.event.source.threadId).toBe("1700000000.222222");
    });

    it("omits source.threadId when thread_ts is absent (top-level channel message)", () => {
      const config = makeConfig();
      const event = makeChannelEvent();
      const result = normalizeSlackChannelMessage(event, "evt-tid-4", config);

      expect(result).not.toBeNull();
      expect(result!.event.source.threadId).toBeUndefined();
    });
  });

  describe("normalizeSlackAppMention", () => {
    it("populates source.threadId when thread_ts is present", () => {
      const config = makeConfig();
      const event = makeAppMentionEvent({ thread_ts: "1700000000.333333" });
      const result = normalizeSlackAppMention(event, "evt-tid-5", config);

      expect(result).not.toBeNull();
      expect(result!.event.source.threadId).toBe("1700000000.333333");
    });

    it("omits source.threadId when thread_ts is absent", () => {
      const config = makeConfig();
      const event = makeAppMentionEvent();
      const result = normalizeSlackAppMention(event, "evt-tid-6", config);

      expect(result).not.toBeNull();
      expect(result!.event.source.threadId).toBeUndefined();
    });
  });

  describe("normalizeSlackReactionAdded", () => {
    it("populates source.threadId with the reacted message's ts", () => {
      const config = makeConfig();
      const event = makeReactionAddedEvent({
        messageTs: "1700000000.444444",
      });
      const result = normalizeSlackReactionAdded(event, "evt-tid-7", config);

      expect(result).not.toBeNull();
      // Reactions route replies against the reacted message, so threadId
      // mirrors the wrapper's threadTs (which equals item.ts).
      expect(result!.event.source.threadId).toBe("1700000000.444444");
      expect(result!.threadTs).toBe("1700000000.444444");
    });
  });

  describe("normalizeSlackMessageEdit", () => {
    it("populates source.threadId for channel edits inside a thread", () => {
      const config = makeConfig();
      const event = makeMessageChangedEvent({
        threadTs: "1700000000.555555",
      });
      const result = normalizeSlackMessageEdit(event, "evt-tid-8", config);

      expect(result).not.toBeNull();
      expect(result!.event.source.threadId).toBe("1700000000.555555");
    });

    it("omits source.threadId for channel edits with no thread", () => {
      const config = makeConfig();
      const event = makeMessageChangedEvent();
      const result = normalizeSlackMessageEdit(event, "evt-tid-9", config);

      expect(result).not.toBeNull();
      expect(result!.event.source.threadId).toBeUndefined();
    });

    it("omits source.threadId for DM edits with no thread", () => {
      const config = makeConfig();
      const event = makeMessageChangedEvent({
        channel: "D789",
        channelType: "im",
      });
      const result = normalizeSlackMessageEdit(event, "evt-tid-10", config);

      expect(result).not.toBeNull();
      expect(result!.event.source.threadId).toBeUndefined();
    });
  });
});
