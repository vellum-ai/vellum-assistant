import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { OutlookDeltaResponse } from "../messaging/providers/outlook/types.js";
import type { OutlookMessage } from "../messaging/providers/outlook/types.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockListMessagesDelta =
  mock<
    (
      connection: unknown,
      folderId: string,
      deltaLink?: string,
    ) => Promise<OutlookDeltaResponse<OutlookMessage>>
  >();

const mockListMessages =
  mock<
    (
      connection: unknown,
      options?: Record<string, unknown>,
    ) => Promise<{ value?: OutlookMessage[] }>
  >();

mock.module("../messaging/providers/outlook/client.js", () => ({
  listMessagesDelta: mockListMessagesDelta,
  listMessages: mockListMessages,
  OutlookApiError: class OutlookApiError extends Error {
    status: number;
    statusText: string;
    constructor(status: number, statusText: string, message: string) {
      super(message);
      this.name = "OutlookApiError";
      this.status = status;
      this.statusText = statusText;
    }
  },
}));

const mockResolveOAuthConnection =
  mock<(provider: string) => Promise<unknown>>();

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: mockResolveOAuthConnection,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Import module under test after mocks
const { outlookProvider, DeltaSyncExpiredError } =
  await import("../watcher/providers/outlook.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_CONNECTION = { id: "test-conn" };
const DELTA_LINK_1 =
  "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc123";
const DELTA_LINK_2 =
  "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=def456";
const NEXT_LINK =
  "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=page2";

function makeMessage(overrides: Partial<OutlookMessage> = {}): OutlookMessage {
  return {
    id: overrides.id ?? "msg-1",
    conversationId: overrides.conversationId ?? "conv-1",
    subject: overrides.subject ?? "Test Subject",
    bodyPreview: overrides.bodyPreview ?? "Preview text",
    body: overrides.body ?? { contentType: "text", content: "Body text" },
    from: overrides.from ?? {
      emailAddress: { name: "Alice", address: "alice@example.com" },
    },
    toRecipients: overrides.toRecipients ?? [],
    ccRecipients: overrides.ccRecipients ?? [],
    receivedDateTime: overrides.receivedDateTime ?? "2025-06-15T10:00:00.000Z",
    isRead: overrides.isRead ?? false,
    hasAttachments: overrides.hasAttachments ?? false,
    parentFolderId: overrides.parentFolderId ?? "inbox-folder-id",
    categories: overrides.categories ?? [],
    flag: overrides.flag ?? { flagStatus: "notFlagged" },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockListMessagesDelta.mockReset();
  mockListMessages.mockReset();
  mockResolveOAuthConnection.mockReset();
  mockResolveOAuthConnection.mockResolvedValue(FAKE_CONNECTION);
});

describe("Outlook email watcher — getInitialWatermark", () => {
  test("captures the deltaLink from the initial delta query", async () => {
    mockListMessagesDelta.mockResolvedValueOnce({
      value: [],
      "@odata.deltaLink": DELTA_LINK_1,
    });

    const watermark = await outlookProvider.getInitialWatermark("outlook");

    expect(watermark).toBe(DELTA_LINK_1);
    expect(mockListMessagesDelta).toHaveBeenCalledWith(
      FAKE_CONNECTION,
      "inbox",
      undefined,
    );
  });

  test("throws when no deltaLink is returned", async () => {
    mockListMessagesDelta.mockResolvedValueOnce({
      value: [],
    });

    await expect(
      outlookProvider.getInitialWatermark("outlook"),
    ).rejects.toThrow("without returning a deltaLink");
  });
});

describe("Outlook email watcher — fetchNew", () => {
  test("returns empty items and initial watermark when no watermark provided", async () => {
    mockListMessagesDelta.mockResolvedValueOnce({
      value: [],
      "@odata.deltaLink": DELTA_LINK_1,
    });

    const result = await outlookProvider.fetchNew(
      "outlook",
      null,
      {},
      "watcher-1",
    );

    expect(result.items).toEqual([]);
    expect(result.watermark).toBe(DELTA_LINK_1);
  });

  test("returns new messages from delta query", async () => {
    const msg1 = makeMessage({ id: "msg-1", subject: "Hello" });
    const msg2 = makeMessage({
      id: "msg-2",
      subject: "World",
      from: {
        emailAddress: { name: "Bob", address: "bob@example.com" },
      },
    });

    mockListMessagesDelta.mockResolvedValueOnce({
      value: [msg1, msg2],
      "@odata.deltaLink": DELTA_LINK_2,
    });

    const result = await outlookProvider.fetchNew(
      "outlook",
      DELTA_LINK_1,
      {},
      "watcher-1",
    );

    expect(result.items).toHaveLength(2);
    expect(result.watermark).toBe(DELTA_LINK_2);

    expect(result.items[0].externalId).toBe("msg-1");
    expect(result.items[0].eventType).toBe("new_email");
    expect(result.items[0].summary).toBe("Email from Alice: Hello");

    expect(result.items[1].externalId).toBe("msg-2");
    expect(result.items[1].summary).toBe("Email from Bob: World");
  });

  test("returns empty items when delta has no new messages", async () => {
    mockListMessagesDelta.mockResolvedValueOnce({
      value: [],
      "@odata.deltaLink": DELTA_LINK_2,
    });

    const result = await outlookProvider.fetchNew(
      "outlook",
      DELTA_LINK_1,
      {},
      "watcher-1",
    );

    expect(result.items).toEqual([]);
    expect(result.watermark).toBe(DELTA_LINK_2);
  });

  test("handles pagination across multiple delta pages", async () => {
    const msg1 = makeMessage({ id: "msg-1", subject: "Page 1" });
    const msg2 = makeMessage({ id: "msg-2", subject: "Page 2" });

    // First call returns page 1 with nextLink
    mockListMessagesDelta.mockResolvedValueOnce({
      value: [msg1],
      "@odata.nextLink": NEXT_LINK,
    });

    // Second call returns page 2 with deltaLink (end of pagination)
    mockListMessagesDelta.mockResolvedValueOnce({
      value: [msg2],
      "@odata.deltaLink": DELTA_LINK_2,
    });

    const result = await outlookProvider.fetchNew(
      "outlook",
      DELTA_LINK_1,
      {},
      "watcher-1",
    );

    expect(result.items).toHaveLength(2);
    expect(result.items[0].externalId).toBe("msg-1");
    expect(result.items[1].externalId).toBe("msg-2");
    expect(result.watermark).toBe(DELTA_LINK_2);

    // First call uses the stored watermark (deltaLink)
    expect(mockListMessagesDelta).toHaveBeenCalledTimes(2);
    expect(mockListMessagesDelta.mock.calls[0]).toEqual([
      FAKE_CONNECTION,
      "inbox",
      DELTA_LINK_1,
    ]);
    // Second call uses the nextLink
    expect(mockListMessagesDelta.mock.calls[1]).toEqual([
      FAKE_CONNECTION,
      "inbox",
      NEXT_LINK,
    ]);
  });

  test("handles 410 expired sync state with fallback", async () => {
    // Import the mocked OutlookApiError class
    const { OutlookApiError } =
      await import("../messaging/providers/outlook/client.js");

    // Delta query returns 410 Gone
    mockListMessagesDelta.mockRejectedValueOnce(
      new OutlookApiError(410, "Gone", "Sync state expired"),
    );

    // Fallback: listMessages returns recent messages
    const recentMsg = makeMessage({ id: "recent-1", subject: "Recent Email" });
    mockListMessages.mockResolvedValueOnce({
      value: [recentMsg],
    });

    // After fallback, get fresh deltaLink
    mockListMessagesDelta.mockResolvedValueOnce({
      value: [],
      "@odata.deltaLink": DELTA_LINK_2,
    });

    const result = await outlookProvider.fetchNew(
      "outlook",
      DELTA_LINK_1,
      {},
      "watcher-1",
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].externalId).toBe("recent-1");
    expect(result.items[0].summary).toBe("Email from Alice: Recent Email");
    expect(result.watermark).toBe(DELTA_LINK_2);

    // Verify fallback called listMessages with appropriate filter
    expect(mockListMessages).toHaveBeenCalledTimes(1);
    const listCallArgs = mockListMessages.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(listCallArgs.folderId).toBe("inbox");
    expect(listCallArgs.top).toBe(20);
    expect(listCallArgs.filter).toMatch(/receivedDateTime ge /);
  });

  test("empty delta response returns no items with updated watermark", async () => {
    mockListMessagesDelta.mockResolvedValueOnce({
      "@odata.deltaLink": DELTA_LINK_2,
    });

    const result = await outlookProvider.fetchNew(
      "outlook",
      DELTA_LINK_1,
      {},
      "watcher-1",
    );

    expect(result.items).toEqual([]);
    expect(result.watermark).toBe(DELTA_LINK_2);
  });
});

describe("DeltaSyncExpiredError", () => {
  test("has correct name and message", () => {
    const err = new DeltaSyncExpiredError("sync state lost");
    expect(err.name).toBe("DeltaSyncExpiredError");
    expect(err.message).toBe("sync state lost");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("Outlook email watcher — provider metadata", () => {
  test("has correct id, displayName, and requiredCredentialService", () => {
    expect(outlookProvider.id).toBe("outlook");
    expect(outlookProvider.displayName).toBe("Outlook");
    expect(outlookProvider.requiredCredentialService).toBe("outlook");
  });
});
