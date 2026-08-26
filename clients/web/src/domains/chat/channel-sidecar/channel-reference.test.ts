import { describe, expect, test } from "bun:test";

import {
  formatChannelReference,
  prependChannelReference,
  toChannelReference,
  CHANNEL_REFERENCE_SNIPPET_MAX,
  type ChannelReference,
} from "@/domains/chat/channel-sidecar/channel-reference";
import type { ChannelTranscriptEntry } from "@/domains/chat/channel-sidecar/channel-sidecar-transcript";

const FULL: ChannelReference = {
  messageId: "msg-1",
  conversationId: "conv-1",
  channelId: "slack",
  channelLabel: "Slack",
  threadName: "general",
  externalMessageId: "1712345678.000200",
  externalThreadId: "1712345600.000100",
  externalChatId: "C0123",
  senderName: "Alice",
  timestamp: Date.UTC(2026, 7, 26, 14, 3, 0),
  sourceHref: "https://example.com/archives/C0123/p1712345678000200",
  snippet: "can you look at the deploy?",
  isTruncated: false,
};

describe("formatChannelReference", () => {
  test("emits every coordinate the assistant needs, one per line", () => {
    expect(formatChannelReference(FULL)).toBe(
      [
        "> [vellum:channel-reference]",
        "> channel: slack",
        "> conversation: C0123",
        "> conversation-name: general",
        "> thread: 1712345600.000100",
        "> message-id: 1712345678.000200",
        "> sender: Alice",
        "> sent-at: 2026-08-26T14:03:00.000Z",
        "> source: https://example.com/archives/C0123/p1712345678000200",
        "> text:",
        ">   can you look at the deploy?",
        "> [/vellum:channel-reference]",
      ].join("\n"),
    );
  });

  test("omits fields the channel did not report rather than emitting them blank", () => {
    const sparse: ChannelReference = {
      messageId: "msg-2",
      conversationId: "conv-1",
      channelId: "telegram",
      channelLabel: "Telegram",
      snippet: "ping",
      isTruncated: false,
    };

    const block = formatChannelReference(sparse);

    expect(block).toContain("> channel: telegram");
    expect(block).not.toContain("sender:");
    expect(block).not.toContain("thread:");
    expect(block).not.toContain("message-id:");
    expect(block).not.toContain("sent-at:");
    expect(block).not.toContain("source:");
  });

  test("marks a snapshot that was cut", () => {
    expect(
      formatChannelReference({ ...FULL, isTruncated: true }),
    ).toContain("> snippet-truncated: true");
  });

  test("quotes every line of a multi-line body so the block stays one quote", () => {
    const block = formatChannelReference({
      ...FULL,
      snippet: "first line\nsecond line",
    });

    expect(block).toContain(">   first line");
    expect(block).toContain(">   second line");
    for (const line of block.split("\n")) {
      expect(line.startsWith(">")).toBe(true);
    }
  });

  test("says so rather than emitting an empty body", () => {
    expect(formatChannelReference({ ...FULL, snippet: "" })).toContain(
      ">   (no text content)",
    );
  });
});

describe("prependChannelReference", () => {
  test("leads with the reference and follows with the user's remark", () => {
    const result = prependChannelReference("what should I do?", FULL);

    expect(result.startsWith("> [vellum:channel-reference]")).toBe(true);
    expect(result.endsWith("\n\nwhat should I do?")).toBe(true);
  });

  test("sends the reference alone when nothing was typed", () => {
    expect(prependChannelReference("", FULL)).toBe(
      formatChannelReference(FULL),
    );
  });

  test("is a no-op with nothing staged", () => {
    expect(prependChannelReference("plain message", null)).toBe(
      "plain message",
    );
  });
});

describe("toChannelReference", () => {
  const entry: ChannelTranscriptEntry = {
    id: "msg-9",
    role: "user",
    text: "deploy is red",
    timestamp: 1_700_000_000_000,
    provenance: {
      channelId: "slack",
      kind: "message",
      externalMessageId: "1700000000.000100",
      externalChatId: "C0123",
      senderName: "Alice",
      sourceLink: { webUrl: "https://example.com/message" },
    },
  };

  test("prefers the row's own link over the thread's", () => {
    const reference = toChannelReference({
      entry,
      target: {
        conversationId: "conv-1",
        channelId: "slack",
        threadName: "general",
        sourceHref: "https://example.com/thread",
      },
      channelLabel: "Slack",
    });

    expect(reference.sourceHref).toBe("https://example.com/message");
    expect(reference.messageId).toBe("msg-9");
    expect(reference.threadName).toBe("general");
    expect(reference.channelLabel).toBe("Slack");
  });

  test("bounds the snippet and flags the cut; the entry keeps its full text", () => {
    const long = "x".repeat(CHANNEL_REFERENCE_SNIPPET_MAX + 50);
    const reference = toChannelReference({
      entry: { ...entry, text: long },
      target: { conversationId: "conv-1", channelId: "slack" },
      channelLabel: "Slack",
    });

    expect(reference.isTruncated).toBe(true);
    expect(reference.snippet.length).toBeLessThanOrEqual(
      CHANNEL_REFERENCE_SNIPPET_MAX + 1,
    );
    expect(reference.snippet.endsWith("…")).toBe(true);
  });

  test("falls back to the thread's link when the row has none", () => {
    const reference = toChannelReference({
      entry: { ...entry, provenance: { channelId: "slack", kind: "message" } },
      target: {
        conversationId: "conv-1",
        channelId: "slack",
        sourceHref: "https://example.com/thread",
      },
      channelLabel: "Slack",
    });

    expect(reference.sourceHref).toBe("https://example.com/thread");
    expect(reference.senderName).toBeUndefined();
  });
});
