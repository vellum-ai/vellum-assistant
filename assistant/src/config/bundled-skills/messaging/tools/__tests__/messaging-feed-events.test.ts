import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { EmitFeedEventParams } from "../../../../../home/emit-feed-event.js";

// Capture all emitFeedEvent calls
const emittedEvents: EmitFeedEventParams[] = [];

mock.module("../../../../../home/emit-feed-event.js", () => ({
  emitFeedEvent: async (params: EmitFeedEventParams) => {
    emittedEvents.push(params);
    return {
      id: `emit:${params.source}:${params.dedupKey ?? "random"}`,
      type: "action",
      source: params.source,
      title: params.title,
      summary: params.summary,
      priority: 50,
      status: "new",
      author: "assistant",
      timestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
  },
}));

// Stub messaging provider dependencies
const mockCreateDraft = mock(async () => ({ id: "draft-123" }));
const mockCreateDraftRaw = mock(async () => ({ id: "draft-raw-456" }));
const mockGetThread = mock(async () => ({
  messages: [
    {
      payload: {
        headers: [
          { name: "From", value: "sender@example.com" },
          { name: "To", value: "user@example.com" },
          { name: "Subject", value: "Test Subject" },
          { name: "Message-ID", value: "<msg-1@example.com>" },
        ],
      },
    },
  ],
}));
const mockGetProfile = mock(async () => ({
  emailAddress: "user@example.com",
}));

mock.module("../../../../../messaging/providers/gmail/client.js", () => ({
  createDraft: mockCreateDraft,
  createDraftRaw: mockCreateDraftRaw,
  getThread: mockGetThread,
  getProfile: mockGetProfile,
}));

mock.module("../../../../../messaging/providers/gmail/mime-builder.js", () => ({
  buildMultipartMime: () => "mock-raw-mime",
}));

const mockSendMessage = mock(async () => ({
  id: "msg-sent-789",
  threadId: "thread-1",
}));
const mockArchiveByQuery = mock(async () => ({
  archived: 3,
  truncated: false,
}));

mock.module("../shared.js", () => ({
  resolveProvider: async (platform?: string) => ({
    id: platform === "slack" ? "slack" : "gmail",
    displayName: platform === "slack" ? "Slack" : "Gmail",
    sendMessage: mockSendMessage,
    archiveByQuery: mockArchiveByQuery,
  }),
  getProviderConnection: async () => ({ token: "mock-token" }),
  ok: (msg: string) => ({ status: "ok", output: msg }),
  err: (msg: string) => ({ status: "error", output: msg }),
  extractEmail: (addr: string) => addr.replace(/.*<(.+)>/, "$1").toLowerCase(),
  extractHeader: (
    headers: Array<{ name: string; value: string }>,
    name: string,
  ) => headers.find((h: { name: string }) => h.name === name)?.value ?? null,
  parseAddressList: (addrs: string | null) =>
    addrs ? addrs.split(",").map((a: string) => a.trim()) : [],
}));

// Stub gmail-mime-helpers
mock.module("../gmail-mime-helpers.js", () => ({
  guessMimeType: () => "application/octet-stream",
}));

// Stub conversation dependencies used by messaging-send cross-post
mock.module("../../../../../memory/conversation-crud.js", () => ({
  addMessage: async () => ({ id: "msg-1" }),
  getConversation: () => null,
}));
mock.module("../../../../../memory/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));
mock.module("../../../../../memory/external-conversation-store.js", () => ({
  getBindingByChannelChat: () => null,
}));

const { run: runSend } = await import("../messaging-send.js");
const { run: runArchive } = await import("../messaging-archive-by-sender.js");

const baseContext = {
  conversationId: "conv-xyz",
  assistantId: "assistant-1",
  triggeredBySurfaceAction: true,
  batchAuthorizedByTask: false,
  approvedViaPrompt: false,
  trustClass: "guardian" as const,
};

beforeEach(() => {
  emittedEvents.length = 0;
  mockCreateDraft.mockClear();
  mockCreateDraftRaw.mockClear();
  mockSendMessage.mockClear();
  mockArchiveByQuery.mockClear();
});

afterEach(() => {
  emittedEvents.length = 0;
});

describe("messaging-send feed events", () => {
  test("Gmail draft creation emits with source 'gmail' and dedup by draft ID", async () => {
    await runSend(
      {
        platform: "gmail",
        conversation_id: "recipient@example.com",
        text: "Hello there",
        subject: "Test",
      },
      baseContext,
    );

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].source).toBe("gmail");
    expect(emittedEvents[0].title).toBe("Email Draft Created");
    expect(emittedEvents[0].dedupKey).toBe("email-draft:draft-123");
  });

  test("Slack sends emit with source 'slack'", async () => {
    await runSend(
      {
        platform: "slack",
        conversation_id: "#general",
        text: "Hello Slack",
      },
      baseContext,
    );

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].source).toBe("slack");
    expect(emittedEvents[0].title).toBe("Slack Message Sent");
    expect(emittedEvents[0].dedupKey).toBe("message-sent:msg-sent-789");
  });

  test("Non-Gmail, non-Slack sends emit with source 'gmail' as fallback", async () => {
    await runSend(
      {
        platform: "other-email",
        conversation_id: "user@example.com",
        text: "Hello",
      },
      baseContext,
    );

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].source).toBe("gmail");
    // Mock resolveProvider returns id:"gmail" for non-slack platforms,
    // so this goes through the Gmail draft path
    expect(emittedEvents[0].title).toBe("Email Draft Created");
    expect(emittedEvents[0].summary).toBe("Created an email draft.");
  });
});

describe("messaging-archive feed events", () => {
  test("Archive emits only when result.archived > 0", async () => {
    await runArchive(
      { platform: "gmail", query: "from:sender@example.com" },
      baseContext,
    );

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].source).toBe("gmail");
    expect(emittedEvents[0].title).toBe("Messages Archived");
    expect(emittedEvents[0].summary).toContain("Archived 3 message(s)");
  });

  test("Zero-match archives do NOT emit", async () => {
    mockArchiveByQuery.mockResolvedValueOnce({
      archived: 0,
      truncated: false,
    });

    await runArchive(
      { platform: "gmail", query: "from:nobody@example.com" },
      baseContext,
    );

    expect(emittedEvents).toHaveLength(0);
  });
});
