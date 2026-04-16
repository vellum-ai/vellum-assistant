import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../tools/types.js";

const mockBatchModifyMessages =
  mock<
    (
      conn: unknown,
      ids: string[],
      opts: Record<string, unknown>,
    ) => Promise<void>
  >();
const mockListMessages = mock<
  (
    conn: unknown,
    query: string,
    limit: number,
    pageToken?: string,
  ) => Promise<{
    messages?: { id: string }[];
    nextPageToken?: string | null;
  }>
>();
const mockModifyMessage =
  mock<
    (
      conn: unknown,
      messageId: string,
      opts: Record<string, unknown>,
    ) => Promise<void>
  >();
const mockResolveOAuthConnection =
  mock<(provider: string, opts?: unknown) => Promise<unknown>>();

let mockScanStoreReturn: string[] | null = null;

mock.module("../messaging/providers/gmail/client.js", () => ({
  batchModifyMessages: mockBatchModifyMessages,
  listMessages: mockListMessages,
  modifyMessage: mockModifyMessage,
}));

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: mockResolveOAuthConnection,
}));

mock.module(
  "../config/bundled-skills/gmail/tools/scan-result-store.js",
  () => ({
    getSenderMessageIds: () => mockScanStoreReturn,
  }),
);

const { run } =
  await import("../config/bundled-skills/gmail/tools/gmail-archive.js");

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: "conv-1",
    triggeredBySurfaceAction: true,
    ...overrides,
  } as ToolContext;
}

function encodeSenderId(email: string): string {
  return Buffer.from(email).toString("base64url");
}

describe("gmail_archive sender ID fallback", () => {
  afterEach(() => {
    mockBatchModifyMessages.mockReset();
    mockListMessages.mockReset();
    mockModifyMessage.mockReset();
    mockResolveOAuthConnection.mockReset();
    mockScanStoreReturn = null;
  });

  test("falls back to query-based archiving when scan expires", async () => {
    mockScanStoreReturn = null; // expired scan
    mockResolveOAuthConnection.mockResolvedValueOnce({ id: "gmail-conn" });
    mockListMessages.mockResolvedValueOnce({
      messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      nextPageToken: null,
    });
    mockBatchModifyMessages.mockResolvedValueOnce(undefined);

    const senderId = encodeSenderId("spam@example.com");
    const result = await run(
      { scan_id: "expired-scan", sender_ids: [senderId] },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Archived 3 message(s)");
    expect(result.content).toContain("query fallback");
    expect(mockListMessages.mock.calls[0][1]).toBe(
      'from:"spam@example.com" in:inbox',
    );
  });

  test("returns error when scan returns empty array (sender IDs don't match)", async () => {
    mockScanStoreReturn = []; // scan valid but no IDs resolved

    const senderId = encodeSenderId("cold@outreach.io");
    const result = await run(
      { scan_id: "valid-scan", sender_ids: [senderId] },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("do not match the scan results");
  });

  test("handles multiple sender IDs in fallback", async () => {
    mockScanStoreReturn = null;
    mockResolveOAuthConnection.mockResolvedValueOnce({ id: "gmail-conn" });
    mockListMessages
      .mockResolvedValueOnce({
        messages: [{ id: "m1" }, { id: "m2" }],
        nextPageToken: null,
      })
      .mockResolvedValueOnce({
        messages: [{ id: "m3" }],
        nextPageToken: null,
      });
    mockBatchModifyMessages.mockResolvedValueOnce(undefined);

    const senderIds = [
      encodeSenderId("a@example.com"),
      encodeSenderId("b@example.com"),
    ];
    const result = await run(
      { scan_id: "expired", sender_ids: senderIds },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Archived 3 message(s)");
    expect(mockListMessages).toHaveBeenCalledTimes(2);
  });

  test("reports undecodable sender IDs", async () => {
    mockScanStoreReturn = null;
    mockResolveOAuthConnection.mockResolvedValueOnce({ id: "gmail-conn" });
    mockListMessages.mockResolvedValueOnce({
      messages: [{ id: "m1" }],
      nextPageToken: null,
    });
    mockBatchModifyMessages.mockResolvedValueOnce(undefined);

    const validId = encodeSenderId("ok@example.com");
    const invalidId = "not-valid-base64-@@@";
    const result = await run(
      { scan_id: "expired", sender_ids: [validId, invalidId] },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("1 sender ID(s) could not be decoded");
  });

  test("errors when all sender IDs are undecodable", async () => {
    mockScanStoreReturn = null;

    // base64url decodes to something without @
    const noAtId = Buffer.from("noemail").toString("base64url");
    const result = await run(
      { scan_id: "expired", sender_ids: [noAtId] },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("could not be decoded");
  });

  test("returns ok when fallback finds no messages", async () => {
    mockScanStoreReturn = null;
    mockResolveOAuthConnection.mockResolvedValueOnce({ id: "gmail-conn" });
    mockListMessages.mockResolvedValueOnce({
      messages: [],
      nextPageToken: null,
    });

    const senderId = encodeSenderId("gone@example.com");
    const result = await run(
      { scan_id: "expired", sender_ids: [senderId] },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("No inbox messages found");
  });
});
