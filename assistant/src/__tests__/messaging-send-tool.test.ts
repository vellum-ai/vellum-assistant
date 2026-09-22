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

// "phone" is a provider with a send of its own and no channel transport, so
// its send stays tool-mediated; "outlook" drafts. A channel with a transport
// (slack, telegram) never reaches a provider's send: the tool hands it to
// the transport-backed send, which is what these tests prove.
const phoneProvider = makeProvider("phone", "Phone");
const outlookProvider = makeProvider("outlook", "Outlook");
const telegramProvider: MessagingProvider = {
  ...makeProvider("telegram", "Telegram"),
  sendMessage: undefined,
};

let provider: MessagingProvider = phoneProvider;
let connection: OAuthConnection | undefined = undefined;

/** Fires during provider resolution, the first await after the entry guard. */
let onResolveProvider: (() => void) | null = null;

mock.module("../config/bundled-skills/messaging/tools/shared.js", () => ({
  resolveProvider: () => {
    onResolveProvider?.();
    return provider;
  },
  getProviderConnection: () => connection,
  ok: (content: string) => ({ content, isError: false }),
  err: (content: string) => ({ content, isError: true }),
  extractHeader: () => "",
  parseAddressList: () => [],
  extractEmail: (a: string) => a.toLowerCase(),
  isMailboxAddress: (value: string) => value.includes("@"),
}));

// ── The transport-backed send ──

const ADDRESSABLE = new Set(["slack", "telegram", "discord", "whatsapp"]);
const sendChannelTextMock = mock(async (params: Record<string, unknown>) => ({
  channel: params.channel,
  chatId: (params.target as { chatId: string }).chatId,
  ...((params.target as { threadId?: string }).threadId
    ? { threadId: (params.target as { threadId?: string }).threadId }
    : {}),
  messageIds: ["1700000000.000100"],
  lastMessageId: "1700000000.000100",
  recordedIn: "home-1",
}));

mock.module("../runtime/channel-send.js", () => ({
  isProactivelyAddressable: (channel: string) => ADDRESSABLE.has(channel),
  sendChannelText: sendChannelTextMock,
}));

const mockOutlookCreateDraft = mock(
  async (_conn: OAuthConnection, _draft: Record<string, unknown>) => ({
    id: "outlook-draft-1",
    conversationId: "conv-draft",
    subject: "Docs",
    webLink: "https://outlook.office.com/mail/drafts/id/outlook-draft-1",
  }),
);

const mockOutlookCreateReplyDraft = mock(
  async (_conn: OAuthConnection, _messageId: string, _comment?: string) => ({
    id: "outlook-reply-draft-1",
    conversationId: "conv-reply",
    subject: "Re: Hello",
    webLink: "https://outlook.office.com/mail/drafts/id/outlook-reply-draft-1",
  }),
);

mock.module("../messaging/providers/outlook/client.js", () => ({
  createDraft: mockOutlookCreateDraft,
  createReplyDraft: mockOutlookCreateReplyDraft,
  toOutlookFileAttachments: (
    attachments: Array<{ filename: string; mimeType: string; data: Buffer }>,
  ) =>
    attachments.map((att) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: att.filename,
      contentType: att.mimeType,
      contentBytes: att.data.toString("base64"),
    })),
}));

import { run } from "../config/bundled-skills/messaging/tools/messaging-send.js";

const turn = {
  workingDir: "/tmp",
  conversationId: "conv-A",
  assistantId: "ast-1",
  trustClass: "guardian" as const,
  executionChannel: "slack",
  requesterChatId: "D0123456789",
  sourceThreadId: "1700000000.000001",
};

describe("messaging-send tool", () => {
  beforeEach(() => {
    provider = phoneProvider;
    connection = undefined;
    sendMessageMock.mockClear();
    sendChannelTextMock.mockClear();
    mockOutlookCreateDraft.mockClear();
    mockOutlookCreateReplyDraft.mockClear();
    onResolveProvider = null;
  });

  describe("a channel with a transport", () => {
    test("is sent through the transport-backed send with the turn's snapshot, never a provider", async () => {
      const result = await run(
        {
          platform: "slack",
          conversation_id: "C123",
          thread_id: "1700000000.000009",
          text: "hello",
        },
        turn,
      );

      expect(result.isError).toBe(false);
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(sendChannelTextMock).toHaveBeenCalledTimes(1);
      expect(sendChannelTextMock.mock.calls[0]![0]).toEqual({
        channel: "slack",
        target: {
          kind: "chat",
          chatId: "C123",
          threadId: "1700000000.000009",
        },
        text: "hello",
        renderRichly: true,
        assistantId: "ast-1",
        sender: {
          conversationId: "conv-A",
          executionChannel: "slack",
          requesterChatId: "D0123456789",
          sourceThreadId: "1700000000.000001",
        },
      });
      expect(result.content).toBe(
        'Message sent (ID: 1700000000.000100, "thread_id": "1700000000.000009").',
      );
    });

    test("names the channel outright without resolving a provider, so a channel with no provider is reachable", async () => {
      provider = outlookProvider;
      const result = await run(
        { platform: "discord", conversation_id: "C1", text: "hi" },
        turn,
      );
      expect(result.isError).toBe(false);
      expect(sendChannelTextMock.mock.calls[0]![0]).toMatchObject({
        channel: "discord",
        target: { kind: "chat", chatId: "C1" },
      });
    });

    test("an auto-detected provider that is a channel goes through the transport too", async () => {
      provider = telegramProvider;
      const result = await run(
        { conversation_id: "123456789", text: "hi" },
        turn,
      );
      expect(result.isError).toBe(false);
      expect(sendChannelTextMock.mock.calls[0]![0]).toMatchObject({
        channel: "telegram",
        target: { kind: "chat", chatId: "123456789" },
      });
    });

    test("rejects attachments before any send", async () => {
      const result = await run(
        {
          platform: "slack",
          conversation_id: "C123",
          text: "with a file",
          attachment_paths: ["/tmp/does-not-matter.pdf"],
        },
        turn,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Gmail and Outlook");
      expect(sendChannelTextMock).not.toHaveBeenCalled();
    });

    test("refuses an account rather than sending from the channel's default identity", async () => {
      const result = await run(
        {
          platform: "slack",
          account: "workspace-b@example.com",
          conversation_id: "C123",
          text: "hi",
        },
        turn,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("account does not apply to slack");
      expect(sendChannelTextMock).not.toHaveBeenCalled();
    });

    test("a turn cancelled during provider resolution sends nothing", async () => {
      provider = telegramProvider;
      const controller = new AbortController();
      onResolveProvider = () => controller.abort();
      await expect(
        run(
          { conversation_id: "123456789", text: "never sent" },
          { ...turn, signal: controller.signal },
        ),
      ).rejects.toThrow();
      expect(sendChannelTextMock).not.toHaveBeenCalled();
    });

    test("reports the send's refusal as the tool's error", async () => {
      sendChannelTextMock.mockImplementationOnce(async () => {
        throw new Error('Channel "slack" cannot be addressed by person.');
      });
      const result = await run(
        { platform: "slack", conversation_id: "C123", text: "hi" },
        turn,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("cannot be addressed");
    });
  });

  describe("a provider with a send of its own", () => {
    test("passes assistantId from tool context to provider send options", async () => {
      const result = await run(
        {
          platform: "phone",
          conversation_id: "+12125550100",
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
      expect(sendChannelTextMock).not.toHaveBeenCalled();
      expect(sendMessageMock).toHaveBeenCalledWith(
        undefined,
        "+12125550100",
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

    test("passes threadId to provider when replying", async () => {
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

    test("a provider with neither a send nor a transport is refused", async () => {
      provider = { ...makeProvider("fax", "Fax"), sendMessage: undefined };
      const result = await run(
        { platform: "fax", conversation_id: "1", text: "hi" },
        turn,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Fax cannot send from here");
      expect(sendChannelTextMock).not.toHaveBeenCalled();
    });
  });

  describe("Outlook drafts", () => {
    test("reads and forwards attachments onto an Outlook draft", async () => {
      const dir = mkdtempSync(join(tmpdir(), "msg-send-att-"));
      const filePath = join(dir, "report.pdf");
      writeFileSync(filePath, "pdf-bytes");
      provider = outlookProvider;
      connection = {
        id: "outlook-conn-1",
        provider: "outlook",
      } as OAuthConnection;

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
        expect(result.content).toContain("Outlook draft created");
        expect(result.content).toContain("Draft ID: outlook-draft-1");
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(mockOutlookCreateDraft).toHaveBeenCalledTimes(1);
        expect(mockOutlookCreateDraft).toHaveBeenCalledWith(
          connection,
          expect.objectContaining({
            subject: "Docs",
            body: { contentType: "text", content: "see attached" },
            toRecipients: [{ emailAddress: { address: "user@example.com" } }],
            attachments: [expect.objectContaining({ name: "report.pdf" })],
          }),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("creates an Outlook draft without a To address when conversation_id is not an email", async () => {
      provider = outlookProvider;
      connection = {
        id: "outlook-conn-1",
        provider: "outlook",
      } as OAuthConnection;

      const result = await run(
        {
          platform: "outlook",
          conversation_id: "drafts",
          text: "Hey team, here is the update.",
          subject: "Team update",
        },
        {
          workingDir: "/tmp",
          conversationId: "conv-1",
          assistantId: "ast-alpha",
          trustClass: "guardian" as const,
        },
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Outlook draft created");
      expect(result.content).toContain("No recipient set");
      expect(result.content).toContain("Open it:");
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(mockOutlookCreateDraft).toHaveBeenCalledWith(
        connection,
        expect.objectContaining({
          subject: "Team update",
          body: {
            contentType: "text",
            content: "Hey team, here is the update.",
          },
        }),
      );
      const draftArg = mockOutlookCreateDraft.mock.calls[0][1];
      expect(draftArg.toRecipients).toBeUndefined();
    });

    test("creates an Outlook reply draft instead of sending when in_reply_to is set", async () => {
      provider = outlookProvider;
      connection = {
        id: "outlook-conn-1",
        provider: "outlook",
      } as OAuthConnection;

      const result = await run(
        {
          platform: "outlook",
          conversation_id: "user@example.com",
          text: "Thanks, that works.",
          in_reply_to: "AAMk-original",
        },
        {
          workingDir: "/tmp",
          conversationId: "conv-1",
          assistantId: "ast-alpha",
          trustClass: "guardian" as const,
        },
      );

      expect(result.isError).toBe(false);
      expect(mockOutlookCreateReplyDraft).toHaveBeenCalledWith(
        connection,
        "AAMk-original",
        "Thanks, that works.",
      );
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(result.content).toContain("outlook-reply-draft-1");
    });

    test("errors when Outlook is not connected", async () => {
      provider = outlookProvider;
      connection = undefined;

      const result = await run(
        {
          platform: "outlook",
          conversation_id: "user@example.com",
          text: "hello",
        },
        {
          workingDir: "/tmp",
          conversationId: "conv-1",
          assistantId: "ast-alpha",
          trustClass: "guardian" as const,
        },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("OAuth connection");
      expect(mockOutlookCreateDraft).not.toHaveBeenCalled();
    });
  });

  /**
   * Provider and connection resolution and the attachment reads all sit
   * between the tool's entry guard and the Graph call, so a turn stopped
   * during them must not leave a draft in the user's mailbox. The stop lands
   * inside provider resolution rather than before the call, which is what
   * makes these exercise the recheck instead of the entry guard.
   */
  describe("a cancelled turn creates no Outlook draft", () => {
    function abortedContext() {
      const controller = new AbortController();
      onResolveProvider = () => controller.abort();
      return {
        workingDir: "/tmp",
        conversationId: "conv-1",
        assistantId: "ast-alpha",
        trustClass: "guardian" as const,
        signal: controller.signal,
      };
    }

    test("new message", async () => {
      provider = outlookProvider;
      connection = {
        id: "outlook-conn-1",
        provider: "outlook",
      } as OAuthConnection;

      await expect(
        run(
          {
            platform: "outlook",
            conversation_id: "user@example.com",
            text: "never sent",
            subject: "Docs",
          },
          abortedContext(),
        ),
      ).rejects.toThrow();
      expect(mockOutlookCreateDraft).not.toHaveBeenCalled();
    });

    test("reply", async () => {
      provider = outlookProvider;
      connection = {
        id: "outlook-conn-1",
        provider: "outlook",
      } as OAuthConnection;

      await expect(
        run(
          {
            platform: "outlook",
            conversation_id: "user@example.com",
            text: "never sent",
            in_reply_to: "msg-1",
          },
          abortedContext(),
        ),
      ).rejects.toThrow();
      expect(mockOutlookCreateReplyDraft).not.toHaveBeenCalled();
    });
  });
});
