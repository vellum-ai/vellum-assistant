import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { MessagingProvider } from "../messaging/provider.js";
import type { SendOptions } from "../messaging/provider-types.js";
import type { OAuthConnection } from "../oauth/connection.js";

const sendMessageMock = mock(async (..._args: unknown[]) => ({
  id: "msg-1",
  timestamp: 123,
  conversationId: "conv-1",
}));

function makeProvider(id: string, displayName: string): MessagingProvider {
  return {
    id,
    displayName,
    credentialService: id,
    capabilities: new Set(["send"]),
    testConnection: async () => ({
      connected: true,
      user: "x",
      platform: id,
    }),
    listConversations: async () => [],
    getHistory: async () => [],
    search: async () => ({ total: 0, messages: [], hasMore: false }),
    sendMessage: (
      connection: OAuthConnection | undefined,
      conversationId: string,
      text: string,
      options?: SendOptions,
    ) => sendMessageMock(connection, conversationId, text, options),
  };
}

// "outlook" is a messaging provider but not a channel (it is not in
// CHANNEL_IDS): a send through it has no chat conversation to record in.
// "phone" and "telegram" are channels.
const phoneProvider = makeProvider("phone", "Phone");
const telegramProvider = makeProvider("telegram", "Telegram");
const outlookProvider = makeProvider("outlook", "Outlook");
// Slack's provider threads exactly where it is told and reports that thread
// on the result; Telegram's ignores a requested thread and reports none.
const slackProvider: MessagingProvider = {
  ...makeProvider("slack", "Slack"),
  sendMessage: async (_connection, conversationId, _text, options) => ({
    id: "1700000000.000100",
    timestamp: 123,
    conversationId,
    ...(options?.threadId ? { threadId: options.threadId } : {}),
  }),
};
let provider: MessagingProvider = phoneProvider;

mock.module("../config/bundled-skills/messaging/tools/shared.js", () => ({
  resolveProvider: () => provider,
  getProviderConnection: () => undefined,
  ok: (content: string) => ({ content, isError: false }),
  err: (content: string) => ({ content, isError: true }),
  extractHeader: () => "",
  parseAddressList: () => [],
  extractEmail: (a: string) => a.toLowerCase(),
}));

// ── Sent-post record dependency mocks ──

const getConversationMock = mock(
  (_id: string) => null as { id: string; createdAt: number } | null,
);

const syncMessageToDiskMock = mock(
  (_conversationId: string, _messageId: string, _createdAtMs: number) => {},
);

const resolveProactiveHomeConversationMock = mock(
  async (_params: Record<string, unknown>) => ({
    conversationId: "home-1",
    createdNewConversation: false,
  }),
);

const recordDeliveredChannelPostMock = mock(
  async (_post: Record<string, unknown>) => ({ messageId: "row-1" }),
);

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getConversation: getConversationMock,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: syncMessageToDiskMock,
}));

mock.module("../notifications/conversation-pairing.js", () => ({
  resolveProactiveHomeConversation: resolveProactiveHomeConversationMock,
}));

mock.module("../persistence/external-conversation-store.js", () => ({
  normalizeExternalThreadId: (value: string | null | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  },
}));

mock.module("../notifications/delivered-post-record.js", () => ({
  recordDeliveredChannelPost: recordDeliveredChannelPostMock,
}));

import { run } from "../config/bundled-skills/messaging/tools/messaging-send.js";

describe("messaging-send tool", () => {
  beforeEach(() => {
    provider = phoneProvider;
    sendMessageMock.mockClear();
    getConversationMock.mockClear();
    syncMessageToDiskMock.mockClear();
    resolveProactiveHomeConversationMock.mockClear();
    resolveProactiveHomeConversationMock.mockImplementation(async () => ({
      conversationId: "home-1",
      createdNewConversation: false,
    }));
    recordDeliveredChannelPostMock.mockClear();
    recordDeliveredChannelPostMock.mockImplementation(async () => ({
      messageId: "row-1",
    }));
  });

  test("passes assistantId from tool context to provider send options", async () => {
    const result = await run(
      {
        platform: "phone",
        conversation_id: "+15550004444",
        text: "test message",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-1",
        assistantId: "ast-alpha",
        trustClass: "guardian" as const,
      },
    );

    expect(result.isError).toBe(false);
    expect(sendMessageMock).toHaveBeenCalledWith(
      undefined,
      "+15550004444",
      "test message",
      {
        subject: undefined,
        inReplyTo: undefined,
        threadId: undefined,
        attachments: undefined,
        assistantId: "ast-alpha",
      },
    );
  });

  test("passes threadId to provider when replying on non-Gmail platform", async () => {
    const result = await run(
      {
        platform: "phone",
        conversation_id: "conv-1",
        text: "reply text",
        thread_id: "thread-abc",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-1",
        assistantId: "ast-alpha",
        trustClass: "guardian" as const,
      },
    );

    expect(result.isError).toBe(false);
    expect(sendMessageMock).toHaveBeenCalledWith(
      undefined,
      "conv-1",
      "reply text",
      {
        subject: undefined,
        inReplyTo: undefined,
        threadId: "thread-abc",
        attachments: undefined,
        assistantId: "ast-alpha",
      },
    );
  });

  test("rejects attachments on platforms that can't carry them", async () => {
    const result = await run(
      {
        platform: "phone",
        conversation_id: "+12025550142",
        text: "with a file",
        attachment_paths: ["/tmp/does-not-matter.pdf"],
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-1",
        assistantId: "ast-alpha",
        trustClass: "guardian" as const,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Gmail and Outlook");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("reads and forwards attachments to attachment-capable non-Gmail providers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "msg-send-att-"));
    const filePath = join(dir, "report.pdf");
    writeFileSync(filePath, "pdf-bytes");
    provider = outlookProvider;

    try {
      const result = await run(
        {
          platform: "outlook",
          conversation_id: "user@example.com",
          text: "see attached",
          subject: "Docs",
          attachment_paths: [filePath],
        },
        {
          workingDir: "/tmp",
          conversationId: "conv-1",
          assistantId: "ast-alpha",
          trustClass: "guardian" as const,
        },
      );

      expect(result.isError).toBe(false);
      const options = sendMessageMock.mock.calls[0][3] as {
        attachments?: Array<{
          filename: string;
          mimeType: string;
          data: Buffer;
        }>;
      };
      expect(options.attachments).toHaveLength(1);
      expect(options.attachments?.[0]?.filename).toBe("report.pdf");
      expect(options.attachments?.[0]?.mimeType).toBe("application/pdf");
      expect(options.attachments?.[0]?.data.toString()).toBe("pdf-bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records a channel send in the chat's home conversation once the provider has it", async () => {
    provider = telegramProvider;
    getConversationMock.mockImplementation(() => ({
      id: "home-1",
      createdAt: 1700000000000,
    }));

    const result = await run(
      {
        platform: "telegram",
        conversation_id: "123456789",
        text: "hello from A",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
      },
    );

    expect(result.isError).toBe(false);
    expect(resolveProactiveHomeConversationMock).toHaveBeenCalledTimes(1);
    expect(
      resolveProactiveHomeConversationMock.mock.calls[0]![0],
    ).toMatchObject({
      sourceChannel: "telegram",
      externalChatId: "123456789",
    });
    expect(recordDeliveredChannelPostMock).toHaveBeenCalledWith({
      conversationId: "home-1",
      channel: "telegram",
      externalChatId: "123456789",
      text: "hello from A",
      providerMessageId: "msg-1",
      crossPostedFrom: "conv-A",
    });
    expect(syncMessageToDiskMock).toHaveBeenCalledWith(
      "home-1",
      "row-1",
      1700000000000,
    );
  });

  test("records nothing when the home conversation is the sender", async () => {
    provider = telegramProvider;
    resolveProactiveHomeConversationMock.mockImplementation(async () => ({
      conversationId: "conv-A",
      createdNewConversation: false,
    }));

    await run(
      {
        platform: "telegram",
        conversation_id: "123456789",
        text: "hello",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
      },
    );

    expect(recordDeliveredChannelPostMock).not.toHaveBeenCalled();
  });

  test("records nothing when the post landed in the turn's own thread, even though the home is elsewhere", async () => {
    // A Slack agent-style DM keys one conversation per thread. Its home
    // resolves to the chat's notification conversation, so the home test
    // alone would record this send as a cross-post away from the thread it
    // was made in. The turn's own snapshot (channel, chat, thread) decides
    // instead, against the thread the provider says it delivered into.
    provider = slackProvider;

    await run(
      {
        platform: "slack",
        conversation_id: "D0123456789",
        thread_id: "1700000000.000001",
        text: "hello",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
        executionChannel: "slack",
        requesterChatId: "D0123456789",
        sourceThreadId: "1700000000.000001",
      },
    );

    expect(resolveProactiveHomeConversationMock).not.toHaveBeenCalled();
    expect(recordDeliveredChannelPostMock).not.toHaveBeenCalled();
  });

  test("records a send into the turn's chat but a different thread as a cross-post", async () => {
    provider = slackProvider;

    await run(
      {
        platform: "slack",
        conversation_id: "D0123456789",
        thread_id: "1700000000.000002",
        text: "hello",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
        executionChannel: "slack",
        requesterChatId: "D0123456789",
        sourceThreadId: "1700000000.000001",
      },
    );

    expect(resolveProactiveHomeConversationMock).toHaveBeenCalledTimes(1);
    expect(recordDeliveredChannelPostMock).toHaveBeenCalledTimes(1);
  });

  test("a thread-less delivery never matches a turn that arrived in a thread", async () => {
    provider = slackProvider;

    await run(
      {
        platform: "slack",
        conversation_id: "D0123456789",
        text: "hello",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
        executionChannel: "slack",
        requesterChatId: "D0123456789",
        sourceThreadId: "1700000000.000001",
      },
    );

    expect(recordDeliveredChannelPostMock).toHaveBeenCalledTimes(1);
  });

  test("decides by where the provider delivered, not by the thread requested", async () => {
    // Telegram's provider ignores a requested thread and reports none, so a
    // turn that arrived in a topic and asked for that topic still gets a
    // post in the thread-less chat; that post is recorded, not suppressed.
    provider = telegramProvider;

    await run(
      {
        platform: "telegram",
        conversation_id: "123456789",
        thread_id: "777",
        text: "hello",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
        executionChannel: "telegram",
        requesterChatId: "123456789",
        sourceThreadId: "777",
      },
    );

    expect(recordDeliveredChannelPostMock).toHaveBeenCalledTimes(1);
  });

  test("a turn that arrived through no channel falls back to the home comparison", async () => {
    provider = slackProvider;
    resolveProactiveHomeConversationMock.mockImplementation(async () => ({
      conversationId: "conv-A",
      createdNewConversation: false,
    }));

    await run(
      {
        platform: "slack",
        conversation_id: "D0123456789",
        text: "hello",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
      },
    );

    expect(resolveProactiveHomeConversationMock).toHaveBeenCalledTimes(1);
    expect(recordDeliveredChannelPostMock).not.toHaveBeenCalled();
  });

  test("records nothing for a provider that is not a channel", async () => {
    provider = outlookProvider;

    await run(
      {
        platform: "outlook",
        conversation_id: "user@example.com",
        text: "hello",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
      },
    );

    expect(resolveProactiveHomeConversationMock).not.toHaveBeenCalled();
    expect(recordDeliveredChannelPostMock).not.toHaveBeenCalled();
  });

  test("a record failure does not fail the send", async () => {
    provider = telegramProvider;
    getConversationMock.mockImplementation(() => ({
      id: "home-1",
      createdAt: 1700000000000,
    }));
    recordDeliveredChannelPostMock.mockImplementation(async () => {
      throw new Error("DB write failed");
    });

    const result = await run(
      {
        platform: "telegram",
        conversation_id: "123456789",
        text: "hello",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-A",
        assistantId: "ast-1",
        trustClass: "guardian" as const,
      },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Message sent");
  });
});
