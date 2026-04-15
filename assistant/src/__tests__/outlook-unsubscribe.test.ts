import { describe, expect, mock, test } from "bun:test";

import type { OutlookMessage } from "../messaging/providers/outlook/types.js";
import type { ToolContext } from "../tools/types.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockGetMessageWithHeaders =
  mock<(conn: unknown, messageId: string) => Promise<OutlookMessage>>();
const mockSendMessage =
  mock<(conn: unknown, payload: unknown) => Promise<void>>();
const mockResolveOAuthConnection =
  mock<(provider: string, opts?: unknown) => Promise<unknown>>();
const mockResolveRequestAddress =
  mock<
    (
      hostname: string,
      resolveHost: unknown,
      allowPrivate: boolean,
    ) => Promise<{ addresses: string[]; blockedAddress?: string }>
  >();
const mockPinnedHttpsRequest =
  mock<(target: URL, address: string, opts?: unknown) => Promise<number>>();

mock.module("../messaging/providers/outlook/client.js", () => ({
  getMessageWithHeaders: mockGetMessageWithHeaders,
  sendMessage: mockSendMessage,
}));

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: mockResolveOAuthConnection,
}));

mock.module("../tools/network/url-safety.js", () => ({
  isPrivateOrLocalHost: (hostname: string) =>
    hostname === "localhost" || hostname === "127.0.0.1",
  resolveHostAddresses: mock(() => Promise.resolve([])),
  resolveRequestAddress: mockResolveRequestAddress,
}));

mock.module("../config/bundled-skills/gmail/tools/shared.js", () => ({
  pinnedHttpsRequest: mockPinnedHttpsRequest,
  ok: (content: string) => ({ content, isError: false }),
  err: (message: string) => ({ content: message, isError: true }),
}));

mock.module("../config/bundled-skills/outlook/tools/shared.js", () => ({
  pinnedHttpsRequest: mockPinnedHttpsRequest,
  resolveRequestAddress: mockResolveRequestAddress,
  ok: (content: string) => ({ content, isError: false }),
  err: (message: string) => ({ content: message, isError: true }),
}));

// Import after mocks are set up
const { run } =
  await import("../config/bundled-skills/outlook/tools/outlook-unsubscribe.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

const fakeConnection = { id: "outlook-conn-1", provider: "outlook" };

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    triggeredBySurfaceAction: true,
    conversationId: "conv-1",
    ...overrides,
  } as ToolContext;
}

function makeMessage(
  headers: { name: string; value: string }[] = [],
): OutlookMessage {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    subject: "Newsletter",
    bodyPreview: "",
    body: { contentType: "text", content: "" },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: new Date().toISOString(),
    isRead: true,
    hasAttachments: false,
    parentFolderId: "inbox",
    categories: [],
    flag: { flagStatus: "notFlagged" },
    internetMessageHeaders: headers,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("outlook_unsubscribe", () => {
  test("rejects when neither surface action nor batch-authorized task", async () => {
    const result = await run(
      { message_id: "msg-1", confidence: 0.9 },
      makeContext({
        triggeredBySurfaceAction: false,
        batchAuthorizedByTask: false,
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("surface action");
  });

  test("allows scheduled task run with batchAuthorizedByTask", async () => {
    mockResolveOAuthConnection.mockResolvedValueOnce(fakeConnection);
    mockGetMessageWithHeaders.mockResolvedValueOnce(
      makeMessage([
        {
          name: "List-Unsubscribe",
          value: "<https://mail.example.com/unsubscribe?id=789>",
        },
      ]),
    );
    mockResolveRequestAddress.mockResolvedValueOnce({
      addresses: ["93.184.216.34"],
    });
    mockPinnedHttpsRequest.mockResolvedValueOnce(200);

    const result = await run(
      { message_id: "msg-1", confidence: 0.9 },
      makeContext({
        triggeredBySurfaceAction: false,
        batchAuthorizedByTask: true,
      }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Successfully unsubscribed via HTTPS GET");
  });

  test("returns error when message_id is missing", async () => {
    const result = await run({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("message_id is required");
  });

  test("returns error when no List-Unsubscribe header", async () => {
    mockResolveOAuthConnection.mockResolvedValueOnce(fakeConnection);
    mockGetMessageWithHeaders.mockResolvedValueOnce(makeMessage([]));

    const result = await run(
      { message_id: "msg-1", confidence: 0.9 },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No List-Unsubscribe header found");
  });

  test("HTTPS POST unsubscribe with List-Unsubscribe-Post header", async () => {
    mockResolveOAuthConnection.mockResolvedValueOnce(fakeConnection);
    mockGetMessageWithHeaders.mockResolvedValueOnce(
      makeMessage([
        {
          name: "List-Unsubscribe",
          value: "<https://mail.example.com/unsubscribe?id=123>",
        },
        {
          name: "List-Unsubscribe-Post",
          value: "List-Unsubscribe=One-Click-Unsubscribe",
        },
      ]),
    );
    mockResolveRequestAddress.mockResolvedValueOnce({
      addresses: ["93.184.216.34"],
    });
    mockPinnedHttpsRequest.mockResolvedValueOnce(200);

    const result = await run(
      { message_id: "msg-1", confidence: 0.9 },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "Successfully unsubscribed via HTTPS POST",
    );
  });

  test("HTTPS GET unsubscribe without List-Unsubscribe-Post header", async () => {
    mockResolveOAuthConnection.mockResolvedValueOnce(fakeConnection);
    mockGetMessageWithHeaders.mockResolvedValueOnce(
      makeMessage([
        {
          name: "List-Unsubscribe",
          value: "<https://mail.example.com/unsubscribe?id=456>",
        },
      ]),
    );
    mockResolveRequestAddress.mockResolvedValueOnce({
      addresses: ["93.184.216.34"],
    });
    mockPinnedHttpsRequest.mockResolvedValueOnce(200);

    const result = await run(
      { message_id: "msg-1", confidence: 0.9 },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Successfully unsubscribed via HTTPS GET");
  });

  test("mailto fallback sends unsubscribe email via Outlook", async () => {
    mockResolveOAuthConnection.mockResolvedValueOnce(fakeConnection);
    mockGetMessageWithHeaders.mockResolvedValueOnce(
      makeMessage([
        {
          name: "List-Unsubscribe",
          value: "<mailto:unsub@example.com>",
        },
      ]),
    );
    mockSendMessage.mockResolvedValueOnce(undefined);

    const result = await run(
      { message_id: "msg-1", confidence: 0.9 },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "Unsubscribe email sent to unsub@example.com",
    );
    expect(mockSendMessage).toHaveBeenCalledWith(fakeConnection, {
      message: {
        subject: "Unsubscribe",
        body: { contentType: "text", content: "" },
        toRecipients: [{ emailAddress: { address: "unsub@example.com" } }],
      },
    });
  });

  test("DNS rebinding protection blocks private addresses", async () => {
    mockResolveOAuthConnection.mockResolvedValueOnce(fakeConnection);
    mockGetMessageWithHeaders.mockResolvedValueOnce(
      makeMessage([
        {
          name: "List-Unsubscribe",
          value: "<https://evil.example.com/unsubscribe>",
        },
      ]),
    );
    mockResolveRequestAddress.mockResolvedValueOnce({
      addresses: [],
      blockedAddress: "192.168.1.1",
    });

    const result = await run(
      { message_id: "msg-1", confidence: 0.9 },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Unsubscribe URL resolves to a private or local address",
    );
  });

  test("prefers HTTPS over mailto when both present", async () => {
    mockResolveOAuthConnection.mockResolvedValueOnce(fakeConnection);
    mockGetMessageWithHeaders.mockResolvedValueOnce(
      makeMessage([
        {
          name: "List-Unsubscribe",
          value:
            "<mailto:unsub@example.com>, <https://mail.example.com/unsubscribe>",
        },
      ]),
    );
    mockResolveRequestAddress.mockResolvedValueOnce({
      addresses: ["93.184.216.34"],
    });
    mockPinnedHttpsRequest.mockResolvedValueOnce(200);

    const result = await run(
      { message_id: "msg-1", confidence: 0.9 },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Successfully unsubscribed via HTTPS");
  });
});
