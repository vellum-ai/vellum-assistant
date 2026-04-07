import { beforeEach, describe, expect, mock, test } from "bun:test";

// Import client functions directly before mock.module so we get the real implementations
import {
  getAttachment,
  getMessageWithHeaders,
  listAttachments,
  listMasterCategories,
  trashMessage,
  updateMessageCategories,
  updateMessageFlag,
} from "../messaging/providers/outlook/client.js";
import type {
  OutlookDraftMessage,
  OutlookMailFolder,
  OutlookMessage,
} from "../messaging/providers/outlook/types.js";
import type { OAuthConnection } from "../oauth/connection.js";

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockGetProfile = mock(() =>
  Promise.resolve({
    displayName: "Test User",
    mail: "test@outlook.com",
    userPrincipalName: "test@outlook.com",
  }),
);

const mockListMailFolders = mock(() =>
  Promise.resolve([
    {
      id: "inbox-id",
      displayName: "Inbox",
      totalItemCount: 100,
      unreadItemCount: 5,
      childFolderCount: 2,
    } satisfies OutlookMailFolder,
  ]),
);

const mockListMessages = mock(() =>
  Promise.resolve({ value: [] as OutlookMessage[] }),
);

const mockSearchMessages = mock(() =>
  Promise.resolve({
    value: [] as OutlookMessage[],
    "@odata.count": 0 as number | undefined,
  }),
);

const mockSendMessage = mock(() => Promise.resolve(undefined));
const mockMarkMessageRead = mock(() => Promise.resolve(undefined));
const mockReplyToMessage = mock(() => Promise.resolve(undefined));
const mockCreateDraft = mock(() =>
  Promise.resolve({
    id: "draft-1",
    conversationId: "conv-draft",
    subject: "Draft Subject",
    bodyPreview: "Draft preview",
    body: { contentType: "text" as const, content: "Draft body" },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: "2024-06-15T10:30:00Z",
    isRead: true,
    hasAttachments: false,
    parentFolderId: "drafts-id",
    categories: [],
    flag: { flagStatus: "notFlagged" as const },
  } satisfies OutlookMessage),
);
const mockSendDraft = mock(() => Promise.resolve(undefined));
const mockCreateReplyDraft = mock(() =>
  Promise.resolve({
    id: "reply-draft-1",
    conversationId: "conv-reply",
    subject: "Re: Original",
    bodyPreview: "",
    body: { contentType: "text" as const, content: "" },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: "2024-06-15T10:30:00Z",
    isRead: true,
    hasAttachments: false,
    parentFolderId: "drafts-id",
    categories: [],
    flag: { flagStatus: "notFlagged" as const },
  } satisfies OutlookMessage),
);
const mockCreateReplyAllDraft = mock(() =>
  Promise.resolve({
    id: "reply-all-draft-1",
    conversationId: "conv-reply-all",
    subject: "Re: Original",
    bodyPreview: "",
    body: { contentType: "text" as const, content: "" },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: "2024-06-15T10:30:00Z",
    isRead: true,
    hasAttachments: false,
    parentFolderId: "drafts-id",
    categories: [],
    flag: { flagStatus: "notFlagged" as const },
  } satisfies OutlookMessage),
);
const mockCreateForwardDraft = mock(() =>
  Promise.resolve({
    id: "forward-draft-1",
    conversationId: "conv-fwd",
    subject: "Fw: Original",
    bodyPreview: "",
    body: { contentType: "text" as const, content: "" },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: "2024-06-15T10:30:00Z",
    isRead: true,
    hasAttachments: false,
    parentFolderId: "drafts-id",
    categories: [],
    flag: { flagStatus: "notFlagged" as const },
  } satisfies OutlookMessage),
);
const mockListMailRules = mock(() => Promise.resolve({ value: [] }));
const mockCreateMailRule = mock(() => Promise.resolve({}));
const mockDeleteMailRule = mock(() => Promise.resolve(undefined));
const mockGetAutoReplySettings = mock(() => Promise.resolve({}));
const mockUpdateAutoReplySettings = mock(() => Promise.resolve(undefined));
const mockListMessagesDelta = mock(() => Promise.resolve({ value: [] }));

mock.module("../messaging/providers/outlook/client.js", () => ({
  getProfile: mockGetProfile,
  listMailFolders: mockListMailFolders,
  listMessages: mockListMessages,
  searchMessages: mockSearchMessages,
  sendMessage: mockSendMessage,
  markMessageRead: mockMarkMessageRead,
  replyToMessage: mockReplyToMessage,
  createDraft: mockCreateDraft,
  sendDraft: mockSendDraft,
  createReplyDraft: mockCreateReplyDraft,
  createReplyAllDraft: mockCreateReplyAllDraft,
  createForwardDraft: mockCreateForwardDraft,
  listMailRules: mockListMailRules,
  createMailRule: mockCreateMailRule,
  deleteMailRule: mockDeleteMailRule,
  getAutoReplySettings: mockGetAutoReplySettings,
  updateAutoReplySettings: mockUpdateAutoReplySettings,
  listMessagesDelta: mockListMessagesDelta,
}));

import { outlookMessagingProvider } from "../messaging/providers/outlook/adapter.js";
import {
  createDraft,
  createForwardDraft,
  createReplyAllDraft,
  createReplyDraft,
  sendDraft,
} from "../messaging/providers/outlook/client.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockConnection(): OAuthConnection {
  return {
    id: "outlook-conn-1",
    provider: "outlook",
    accountInfo: "test@outlook.com",
    request: mock(() =>
      Promise.resolve({ status: 200, headers: {}, body: {} }),
    ),
    withToken: <T>(fn: (token: string) => Promise<T>) =>
      fn("mock-access-token"),
  };
}

function createMockOutlookMessage(
  overrides?: Partial<OutlookMessage>,
): OutlookMessage {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    subject: "Test Subject",
    bodyPreview: "Preview of the message body",
    body: { contentType: "text", content: "Full message body text" },
    from: {
      emailAddress: { name: "Sender Name", address: "sender@example.com" },
    },
    toRecipients: [
      {
        emailAddress: {
          name: "Recipient",
          address: "recipient@example.com",
        },
      },
    ],
    ccRecipients: [],
    receivedDateTime: "2024-06-15T10:30:00Z",
    isRead: false,
    hasAttachments: false,
    parentFolderId: "inbox-id",
    categories: ["important"],
    flag: { flagStatus: "notFlagged" },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Outlook messaging provider", () => {
  beforeEach(() => {
    mockGetProfile.mockClear();
    mockListMailFolders.mockClear();
    mockListMessages.mockClear();
    mockSearchMessages.mockClear();
    mockSendMessage.mockClear();
    mockMarkMessageRead.mockClear();
    mockReplyToMessage.mockClear();
    mockCreateDraft.mockClear();
    mockSendDraft.mockClear();
    mockCreateReplyDraft.mockClear();
    mockCreateReplyAllDraft.mockClear();
    mockCreateForwardDraft.mockClear();
  });

  // ── testConnection ──────────────────────────────────────────────────────

  describe("testConnection", () => {
    test("returns connected info when connection is valid", async () => {
      const conn = createMockConnection();
      const result = await outlookMessagingProvider.testConnection(conn);

      expect(mockGetProfile).toHaveBeenCalledWith(conn);
      expect(result).toEqual({
        connected: true,
        user: "test@outlook.com",
        platform: "outlook",
      });
    });

    test("uses userPrincipalName when mail is empty", async () => {
      mockGetProfile.mockImplementation(() =>
        Promise.resolve({
          displayName: "Test User",
          mail: "",
          userPrincipalName: "upn@outlook.com",
        }),
      );

      const conn = createMockConnection();
      const result = await outlookMessagingProvider.testConnection(conn);

      expect(result.user).toBe("upn@outlook.com");
    });

    test("throws when connection is undefined", async () => {
      await expect(
        outlookMessagingProvider.testConnection(undefined),
      ).rejects.toThrow("Outlook requires an OAuth connection");
    });
  });

  // ── listConversations ──────────────────────────────────────────────────

  describe("listConversations", () => {
    test("maps mail folders to conversations", async () => {
      const conn = createMockConnection();
      const conversations =
        await outlookMessagingProvider.listConversations(conn);

      expect(mockListMailFolders).toHaveBeenCalledWith(conn);
      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toMatchObject({
        id: "inbox-id",
        name: "Inbox",
        type: "inbox",
        platform: "outlook",
        unreadCount: 5,
        metadata: {
          totalItemCount: 100,
          childFolderCount: 2,
        },
      });
    });

    test("throws when connection is undefined", async () => {
      await expect(
        outlookMessagingProvider.listConversations(undefined),
      ).rejects.toThrow("Outlook requires an OAuth connection");
    });
  });

  // ── getHistory ─────────────────────────────────────────────────────────

  describe("getHistory", () => {
    test("calls listMessages with folder ID and maps results", async () => {
      const msg = createMockOutlookMessage();
      mockListMessages.mockImplementation(() =>
        Promise.resolve({ value: [msg] }),
      );

      const conn = createMockConnection();
      const messages = await outlookMessagingProvider.getHistory(
        conn,
        "folder-id",
      );

      expect(mockListMessages).toHaveBeenCalledWith(conn, {
        folderId: "folder-id",
        top: 50,
        orderby: "receivedDateTime desc",
        select: expect.stringContaining("id,conversationId"),
      });
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-1");
    });

    test("respects limit option", async () => {
      mockListMessages.mockImplementation(() => Promise.resolve({ value: [] }));

      const conn = createMockConnection();
      await outlookMessagingProvider.getHistory(conn, "folder-id", {
        limit: 10,
      });

      expect(mockListMessages).toHaveBeenCalledWith(
        conn,
        expect.objectContaining({ top: 10 }),
      );
    });

    test("returns empty array when response has no value", async () => {
      mockListMessages.mockImplementation(
        () => Promise.resolve({}) as ReturnType<typeof mockListMessages>,
      );

      const conn = createMockConnection();
      const messages = await outlookMessagingProvider.getHistory(
        conn,
        "folder-id",
      );

      expect(messages).toEqual([]);
    });

    test("throws when connection is undefined", async () => {
      await expect(
        outlookMessagingProvider.getHistory(undefined, "folder-id"),
      ).rejects.toThrow("Outlook requires an OAuth connection");
    });
  });

  // ── search ─────────────────────────────────────────────────────────────

  describe("search", () => {
    test("calls searchMessages with query and returns SearchResult", async () => {
      const msg = createMockOutlookMessage();
      mockSearchMessages.mockImplementation(() =>
        Promise.resolve({
          value: [msg],
          "@odata.count": 1,
        }),
      );

      const conn = createMockConnection();
      const result = await outlookMessagingProvider.search(conn, "test query");

      expect(mockSearchMessages).toHaveBeenCalledWith(conn, "test query", {
        top: 20,
      });
      expect(result).toEqual({
        total: 1,
        messages: expect.arrayContaining([
          expect.objectContaining({ id: "msg-1" }),
        ]),
        hasMore: false,
      });
    });

    test("sets hasMore when @odata.nextLink is present", async () => {
      mockSearchMessages.mockImplementation(() =>
        Promise.resolve({
          value: [],
          "@odata.count": 50,
          "@odata.nextLink": "https://graph.microsoft.com/next",
        }),
      );

      const conn = createMockConnection();
      const result = await outlookMessagingProvider.search(conn, "test query");

      expect(result.hasMore).toBe(true);
    });

    test("uses count option for top parameter", async () => {
      mockSearchMessages.mockImplementation(() =>
        Promise.resolve({
          value: [] as OutlookMessage[],
          "@odata.count": 0 as number | undefined,
        }),
      );

      const conn = createMockConnection();
      await outlookMessagingProvider.search(conn, "query", { count: 5 });

      expect(mockSearchMessages).toHaveBeenCalledWith(conn, "query", {
        top: 5,
      });
    });

    test("throws when connection is undefined", async () => {
      await expect(
        outlookMessagingProvider.search(undefined, "query"),
      ).rejects.toThrow("Outlook requires an OAuth connection");
    });
  });

  // ── sendMessage ────────────────────────────────────────────────────────

  describe("sendMessage", () => {
    test("sends a new message with correct recipient, subject, and body", async () => {
      const conn = createMockConnection();
      const result = await outlookMessagingProvider.sendMessage(
        conn,
        "recipient@example.com",
        "Hello!",
        { subject: "Test Subject" },
      );

      expect(mockSendMessage).toHaveBeenCalledWith(conn, {
        message: {
          subject: "Test Subject",
          body: { contentType: "text", content: "Hello!" },
          toRecipients: [
            { emailAddress: { address: "recipient@example.com" } },
          ],
        },
      });
      expect(result).toMatchObject({
        conversationId: "recipient@example.com",
      });
    });

    test("uses empty string for subject when not provided", async () => {
      const conn = createMockConnection();
      await outlookMessagingProvider.sendMessage(
        conn,
        "recipient@example.com",
        "Hello!",
      );

      expect(mockSendMessage).toHaveBeenCalledWith(conn, {
        message: {
          subject: "",
          body: { contentType: "text", content: "Hello!" },
          toRecipients: [
            { emailAddress: { address: "recipient@example.com" } },
          ],
        },
      });
    });

    test("calls replyToMessage when inReplyTo is provided", async () => {
      const conn = createMockConnection();
      const result = await outlookMessagingProvider.sendMessage(
        conn,
        "conv-id",
        "Reply text",
        { inReplyTo: "original-msg-id", threadId: "thread-123" },
      );

      expect(mockReplyToMessage).toHaveBeenCalledWith(
        conn,
        "original-msg-id",
        "Reply text",
      );
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        conversationId: "conv-id",
        threadId: "thread-123",
      });
    });

    test("throws when connection is undefined", async () => {
      await expect(
        outlookMessagingProvider.sendMessage(
          undefined,
          "recipient@example.com",
          "Hello!",
        ),
      ).rejects.toThrow("Outlook requires an OAuth connection");
    });
  });

  // ── markRead ───────────────────────────────────────────────────────────

  describe("markRead", () => {
    test("calls markMessageRead with the message ID", async () => {
      const conn = createMockConnection();
      await outlookMessagingProvider.markRead!(conn, "folder-id", "msg-42");

      expect(mockMarkMessageRead).toHaveBeenCalledWith(conn, "msg-42");
    });

    test("does not call markMessageRead when messageId is undefined", async () => {
      const conn = createMockConnection();
      await outlookMessagingProvider.markRead!(conn, "folder-id");

      expect(mockMarkMessageRead).not.toHaveBeenCalled();
    });

    test("throws when connection is undefined", async () => {
      await expect(
        outlookMessagingProvider.markRead!(undefined, "folder-id", "msg-42"),
      ).rejects.toThrow("Outlook requires an OAuth connection");
    });
  });

  // ── getThreadReplies ──────────────────────────────────────────────────

  describe("getThreadReplies", () => {
    test("calls listMessages with conversationId filter", async () => {
      const msg = createMockOutlookMessage({ conversationId: "thread-abc" });
      mockListMessages.mockImplementation(() =>
        Promise.resolve({ value: [msg] }),
      );

      const conn = createMockConnection();
      const messages = await outlookMessagingProvider.getThreadReplies!(
        conn,
        "folder-id",
        "thread-abc",
      );

      expect(mockListMessages).toHaveBeenCalledWith(conn, {
        filter: "conversationId eq 'thread-abc'",
        top: 50,
        orderby: "receivedDateTime asc",
        select: expect.stringContaining("id,conversationId"),
      });
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-1");
    });

    test("respects limit option", async () => {
      mockListMessages.mockImplementation(() => Promise.resolve({ value: [] }));

      const conn = createMockConnection();
      await outlookMessagingProvider.getThreadReplies!(
        conn,
        "folder-id",
        "thread-abc",
        { limit: 25 },
      );

      expect(mockListMessages).toHaveBeenCalledWith(
        conn,
        expect.objectContaining({ top: 25 }),
      );
    });

    test("throws when connection is undefined", async () => {
      await expect(
        outlookMessagingProvider.getThreadReplies!(
          undefined,
          "folder-id",
          "thread-abc",
        ),
      ).rejects.toThrow("Outlook requires an OAuth connection");
    });
  });

  // ── message mapping ───────────────────────────────────────────────────

  describe("message mapping (via getHistory)", () => {
    test("maps all fields correctly from OutlookMessage to Message", async () => {
      const msg = createMockOutlookMessage();
      mockListMessages.mockImplementation(() =>
        Promise.resolve({ value: [msg] }),
      );

      const conn = createMockConnection();
      const messages = await outlookMessagingProvider.getHistory(
        conn,
        "folder-id",
      );

      const mapped = messages[0];
      expect(mapped).toEqual({
        id: "msg-1",
        conversationId: "conv-1",
        sender: {
          id: "sender@example.com",
          name: "Sender Name",
          email: "sender@example.com",
        },
        text: "Full message body text",
        timestamp: new Date("2024-06-15T10:30:00Z").getTime(),
        threadId: "conv-1",
        platform: "outlook",
        hasAttachments: false,
        metadata: {
          subject: "Test Subject",
          categories: ["important"],
          isRead: false,
          parentFolderId: "inbox-id",
        },
      });
    });

    test("uses bodyPreview when body contentType is html", async () => {
      const msg = createMockOutlookMessage({
        body: {
          contentType: "html",
          content: "<p>HTML content</p>",
        },
        bodyPreview: "HTML preview text",
      });
      mockListMessages.mockImplementation(() =>
        Promise.resolve({ value: [msg] }),
      );

      const conn = createMockConnection();
      const messages = await outlookMessagingProvider.getHistory(
        conn,
        "folder-id",
      );

      expect(messages[0].text).toBe("HTML preview text");
    });

    test("uses email address as sender name when name is missing", async () => {
      const msg = createMockOutlookMessage({
        from: {
          emailAddress: { address: "noname@example.com" },
        },
      });
      mockListMessages.mockImplementation(() =>
        Promise.resolve({ value: [msg] }),
      );

      const conn = createMockConnection();
      const messages = await outlookMessagingProvider.getHistory(
        conn,
        "folder-id",
      );

      expect(messages[0].sender.name).toBe("noname@example.com");
      expect(messages[0].sender.id).toBe("noname@example.com");
      expect(messages[0].sender.email).toBe("noname@example.com");
    });

    test("maps hasAttachments correctly", async () => {
      const msg = createMockOutlookMessage({ hasAttachments: true });
      mockListMessages.mockImplementation(() =>
        Promise.resolve({ value: [msg] }),
      );

      const conn = createMockConnection();
      const messages = await outlookMessagingProvider.getHistory(
        conn,
        "folder-id",
      );

      expect(messages[0].hasAttachments).toBe(true);
    });
  });

  // ── provider metadata ─────────────────────────────────────────────────

  describe("provider metadata", () => {
    test("has correct id and displayName", () => {
      expect(outlookMessagingProvider.id).toBe("outlook");
      expect(outlookMessagingProvider.displayName).toBe("Outlook");
    });

    test("has correct credential service", () => {
      expect(outlookMessagingProvider.credentialService).toBe("outlook");
    });

    test("has correct capabilities", () => {
      expect(outlookMessagingProvider.capabilities.has("threads")).toBe(true);
      expect(outlookMessagingProvider.capabilities.has("folders")).toBe(true);
      expect(outlookMessagingProvider.capabilities.has("archive")).toBe(true);
      expect(outlookMessagingProvider.capabilities.has("categories")).toBe(
        true,
      );
      expect(outlookMessagingProvider.capabilities.has("drafts_native")).toBe(
        true,
      );
      expect(outlookMessagingProvider.capabilities.has("unsubscribe")).toBe(
        true,
      );
    });
  });

  // ── createDraft ──────────────────────────────────────────────────────

  describe("createDraft", () => {
    test("sends POST to /v1.0/me/messages with correct body", async () => {
      const conn = createMockConnection();
      const draft: OutlookDraftMessage = {
        subject: "Draft Subject",
        body: { contentType: "text", content: "Draft body" },
        toRecipients: [{ emailAddress: { address: "to@example.com" } }],
        ccRecipients: [{ emailAddress: { address: "cc@example.com" } }],
        bccRecipients: [{ emailAddress: { address: "bcc@example.com" } }],
      };

      const result = await createDraft(conn, draft);

      expect(mockCreateDraft).toHaveBeenCalledWith(conn, draft);
      expect(result).toMatchObject({
        id: "draft-1",
        subject: "Draft Subject",
      });
    });

    test("returns the created OutlookMessage with id and subject", async () => {
      const conn = createMockConnection();
      const draft: OutlookDraftMessage = {
        subject: "Test",
        body: { contentType: "text", content: "Test body" },
      };

      const result = await createDraft(conn, draft);

      expect(result.id).toBe("draft-1");
      expect(result.subject).toBe("Draft Subject");
      expect(result.parentFolderId).toBe("drafts-id");
    });
  });

  // ── sendDraft ────────────────────────────────────────────────────────

  describe("sendDraft", () => {
    test("sends POST to /v1.0/me/messages/{id}/send", async () => {
      const conn = createMockConnection();

      await sendDraft(conn, "draft-msg-123");

      expect(mockSendDraft).toHaveBeenCalledWith(conn, "draft-msg-123");
    });

    test("returns void on success", async () => {
      const conn = createMockConnection();

      const result = await sendDraft(conn, "draft-msg-123");

      expect(result).toBeUndefined();
    });
  });

  // ── createReplyDraft ─────────────────────────────────────────────────

  describe("createReplyDraft", () => {
    test("sends POST to /v1.0/me/messages/{id}/createReply with comment", async () => {
      const conn = createMockConnection();

      const result = await createReplyDraft(conn, "orig-msg-1", "My reply");

      expect(mockCreateReplyDraft).toHaveBeenCalledWith(
        conn,
        "orig-msg-1",
        "My reply",
      );
      expect(result).toMatchObject({
        id: "reply-draft-1",
        subject: "Re: Original",
      });
    });

    test("sends POST without comment when not provided", async () => {
      const conn = createMockConnection();

      await createReplyDraft(conn, "orig-msg-1");

      expect(mockCreateReplyDraft).toHaveBeenCalledWith(conn, "orig-msg-1");
    });

    test("returns OutlookMessage for the reply draft", async () => {
      const conn = createMockConnection();

      const result = await createReplyDraft(conn, "orig-msg-1");

      expect(result.id).toBe("reply-draft-1");
      expect(result.conversationId).toBe("conv-reply");
    });
  });

  // ── createReplyAllDraft ──────────────────────────────────────────────

  describe("createReplyAllDraft", () => {
    test("sends POST to /v1.0/me/messages/{id}/createReplyAll with comment", async () => {
      const conn = createMockConnection();

      const result = await createReplyAllDraft(
        conn,
        "orig-msg-2",
        "Reply all text",
      );

      expect(mockCreateReplyAllDraft).toHaveBeenCalledWith(
        conn,
        "orig-msg-2",
        "Reply all text",
      );
      expect(result).toMatchObject({
        id: "reply-all-draft-1",
      });
    });

    test("sends POST without comment when not provided", async () => {
      const conn = createMockConnection();

      await createReplyAllDraft(conn, "orig-msg-2");

      expect(mockCreateReplyAllDraft).toHaveBeenCalledWith(conn, "orig-msg-2");
    });

    test("returns OutlookMessage for the reply-all draft", async () => {
      const conn = createMockConnection();

      const result = await createReplyAllDraft(conn, "orig-msg-2");

      expect(result.id).toBe("reply-all-draft-1");
      expect(result.conversationId).toBe("conv-reply-all");
    });
  });

  // ── createForwardDraft ───────────────────────────────────────────────

  describe("createForwardDraft", () => {
    test("sends POST to /v1.0/me/messages/{id}/createForward with recipients and comment", async () => {
      const conn = createMockConnection();
      const recipients = [
        { emailAddress: { address: "forward-to@example.com" } },
      ];

      const result = await createForwardDraft(
        conn,
        "orig-msg-3",
        recipients,
        "FYI",
      );

      expect(mockCreateForwardDraft).toHaveBeenCalledWith(
        conn,
        "orig-msg-3",
        recipients,
        "FYI",
      );
      expect(result).toMatchObject({
        id: "forward-draft-1",
        subject: "Fw: Original",
      });
    });

    test("sends POST without recipients or comment when not provided", async () => {
      const conn = createMockConnection();

      await createForwardDraft(conn, "orig-msg-3");

      expect(mockCreateForwardDraft).toHaveBeenCalledWith(conn, "orig-msg-3");
    });

    test("returns OutlookMessage for the forward draft", async () => {
      const conn = createMockConnection();

      const result = await createForwardDraft(conn, "orig-msg-3");

      expect(result.id).toBe("forward-draft-1");
      expect(result.conversationId).toBe("conv-fwd");
    });
  });
});

// ── Outlook client function tests ──────────────────────────────────────────

describe("Outlook client functions", () => {
  function createClientMockConnection(
    responseBody: unknown = {},
    status = 200,
  ): OAuthConnection {
    return {
      id: "outlook-conn-1",
      provider: "outlook",
      accountInfo: "test@outlook.com",
      request: mock(() =>
        Promise.resolve({ status, headers: {}, body: responseBody }),
      ),
      withToken: <T>(fn: (token: string) => Promise<T>) =>
        fn("mock-access-token"),
    };
  }

  // ── listAttachments ──────────────────────────────────────────────────

  describe("listAttachments", () => {
    test("returns attachment metadata", async () => {
      const attachments = {
        value: [
          {
            id: "att-1",
            name: "file.pdf",
            contentType: "application/pdf",
            size: 12345,
            isInline: false,
          },
        ],
      };
      const conn = createClientMockConnection(attachments);
      const result = await listAttachments(conn, "msg-1");

      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/v1.0/me/messages/msg-1/attachments",
          query: { $select: "id,name,contentType,size,isInline" },
        }),
      );
      expect(result.value).toHaveLength(1);
      expect(result.value![0].name).toBe("file.pdf");
    });
  });

  // ── getAttachment ────────────────────────────────────────────────────

  describe("getAttachment", () => {
    test("returns file content with contentBytes", async () => {
      const attachment = {
        id: "att-1",
        name: "file.pdf",
        contentType: "application/pdf",
        size: 12345,
        isInline: false,
        contentBytes: "dGVzdCBjb250ZW50",
      };
      const conn = createClientMockConnection(attachment);
      const result = await getAttachment(conn, "msg-1", "att-1");

      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/v1.0/me/messages/msg-1/attachments/att-1",
        }),
      );
      expect(result.contentBytes).toBe("dGVzdCBjb250ZW50");
      expect(result.name).toBe("file.pdf");
    });
  });

  // ── trashMessage ─────────────────────────────────────────────────────

  describe("trashMessage", () => {
    test("calls move with destinationId deleteditems", async () => {
      const movedMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Test",
        parentFolderId: "deleteditems",
      };
      const conn = createClientMockConnection(movedMessage);
      const result = await trashMessage(conn, "msg-1");

      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          path: "/v1.0/me/messages/msg-1/move",
          body: { destinationId: "deleteditems" },
        }),
      );
      expect(result.id).toBe("msg-1");
    });
  });

  // ── updateMessageCategories ──────────────────────────────────────────

  describe("updateMessageCategories", () => {
    test("sends PATCH with categories array", async () => {
      const conn = createClientMockConnection(undefined, 204);
      await updateMessageCategories(conn, "msg-1", ["important", "work"]);

      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "PATCH",
          path: "/v1.0/me/messages/msg-1",
          body: { categories: ["important", "work"] },
        }),
      );
    });
  });

  // ── updateMessageFlag ────────────────────────────────────────────────

  describe("updateMessageFlag", () => {
    test("sends PATCH with flag object", async () => {
      const flag = {
        flagStatus: "flagged" as const,
        dueDateTime: {
          dateTime: "2024-12-31T23:59:59",
          timeZone: "UTC",
        },
      };
      const conn = createClientMockConnection(undefined, 204);
      await updateMessageFlag(conn, "msg-1", flag);

      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "PATCH",
          path: "/v1.0/me/messages/msg-1",
          body: { flag },
        }),
      );
    });
  });

  // ── listMasterCategories ─────────────────────────────────────────────

  describe("listMasterCategories", () => {
    test("returns category list", async () => {
      const categories = {
        value: [
          { displayName: "Red Category", color: "preset0" },
          { displayName: "Blue Category", color: "preset7" },
        ],
      };
      const conn = createClientMockConnection(categories);
      const result = await listMasterCategories(conn);

      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/v1.0/me/outlook/masterCategories",
        }),
      );
      expect(result.value).toHaveLength(2);
      expect(result.value![0].displayName).toBe("Red Category");
    });
  });

  // ── getMessageWithHeaders ────────────────────────────────────────────

  describe("getMessageWithHeaders", () => {
    test("includes internetMessageHeaders in select", async () => {
      const message = {
        id: "msg-1",
        subject: "Test",
        internetMessageHeaders: [
          { name: "X-Mailer", value: "TestMailer" },
          { name: "List-Unsubscribe", value: "<mailto:unsub@example.com>" },
        ],
      };
      const conn = createClientMockConnection(message);
      const result = await getMessageWithHeaders(conn, "msg-1");

      expect(conn.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/v1.0/me/messages/msg-1",
          query: {
            $select:
              "id,subject,from,internetMessageHeaders,bodyPreview,body,hasAttachments,receivedDateTime",
          },
        }),
      );
      expect(result.internetMessageHeaders).toHaveLength(2);
      expect(result.internetMessageHeaders![0].name).toBe("X-Mailer");
    });
  });
});
