/**
 * Tests for the daemon-side Slack backfill helpers.
 *
 * Verifies:
 *  - Pass-through of channelId, threadTs, and the `before` cursor.
 *  - Default limit of 50 when none is supplied; explicit limits override.
 *  - resolveConnection() is invoked once per call so any cached read/write
 *    auth mutation lands before the adapter method runs.
 *  - Transient failure modes (timeout, 401, generic Slack API error, missing
 *    connection) return [] instead of propagating the error.
 *  - `channel_not_found` errors are rethrown so wrong-workspace configuration
 *    bugs in multi-account setups surface loudly rather than silently
 *    dropping context.
 *  - `account` is threaded through to resolveConnection() when provided.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { OAuthConnection } from "../../../oauth/connection.js";
import type { HistoryOptions, Message } from "../../provider-types.js";

// ── Module mocks ────────────────────────────────────────────────────────────

type ResolveConnectionFn = (
  account?: string,
) => Promise<OAuthConnection | undefined>;
type GetHistoryFn = (
  connection: OAuthConnection | undefined,
  conversationId: string,
  options?: HistoryOptions,
) => Promise<Message[]>;
type GetThreadRepliesFn = (
  connection: OAuthConnection | undefined,
  conversationId: string,
  threadId: string,
  options?: HistoryOptions,
) => Promise<Message[]>;

const resolveConnectionMock = mock<ResolveConnectionFn>(async () => undefined);
const getHistoryMock = mock<GetHistoryFn>(async () => []);
const getThreadRepliesMock = mock<GetThreadRepliesFn>(async () => []);

mock.module("./adapter.js", () => ({
  slackProvider: {
    id: "slack",
    displayName: "Slack",
    credentialService: "slack",
    capabilities: new Set(["threads"]),
    resolveConnection: (account?: string) => resolveConnectionMock(account),
    getHistory: (
      connection: OAuthConnection | undefined,
      conversationId: string,
      options?: HistoryOptions,
    ) => getHistoryMock(connection, conversationId, options),
    getThreadReplies: (
      connection: OAuthConnection | undefined,
      conversationId: string,
      threadId: string,
      options?: HistoryOptions,
    ) => getThreadRepliesMock(connection, conversationId, threadId, options),
    // Stub the rest of the MessagingProvider surface as no-ops; the backfill
    // helpers should never reach for these.
    testConnection: async () => {
      throw new Error("not used");
    },
    listConversations: async () => [],
    search: async () => ({ total: 0, messages: [], hasMore: false }),
    sendMessage: async () => {
      throw new Error("not used");
    },
  },
}));

import {
  backfillDm,
  backfillThread,
  backfillThreadWindow,
} from "./backfill.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "1700000000.000100",
    conversationId: "C123",
    sender: { id: "U1", name: "Alice" },
    text: "hello",
    timestamp: 1700000000000,
    platform: "slack",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("backfillThread", () => {
  beforeEach(() => {
    resolveConnectionMock.mockReset();
    resolveConnectionMock.mockImplementation(async () => undefined);
    getThreadRepliesMock.mockReset();
    getThreadRepliesMock.mockImplementation(async () => []);
    getHistoryMock.mockReset();
    getHistoryMock.mockImplementation(async () => []);
  });

  test("passes channelId/threadTs through and defaults limit to 50", async () => {
    const reply = makeMessage({
      id: "1700000000.000200",
      threadId: "1700000000.000100",
    });
    getThreadRepliesMock.mockImplementation(async () => [reply]);

    const out = await backfillThread("C123", "1700000000.000100");

    expect(resolveConnectionMock).toHaveBeenCalledTimes(1);
    expect(getThreadRepliesMock).toHaveBeenCalledTimes(1);
    const [conn, channel, thread, opts] = getThreadRepliesMock.mock.calls[0];
    expect(conn).toBeUndefined();
    expect(channel).toBe("C123");
    expect(thread).toBe("1700000000.000100");
    expect(opts).toEqual({ limit: 50 });
    expect(out).toEqual([reply]);
  });

  test("respects explicit limit override", async () => {
    await backfillThread("C123", "1700000000.000100", { limit: 10 });
    const [, , , opts] = getThreadRepliesMock.mock.calls[0];
    expect(opts).toEqual({ limit: 10 });
  });

  test("forwards explicit before/after window through window helper", async () => {
    await backfillThreadWindow("C123", "1700000000.000100", {
      limit: 10,
      after: "1700000000.000100",
      before: "1700000005.000100",
    });

    const [, , , opts] = getThreadRepliesMock.mock.calls[0];
    expect(opts).toEqual({
      limit: 10,
      after: "1700000000.000100",
      before: "1700000005.000100",
    });
  });

  test("forwards cursor through window helper", async () => {
    await backfillThreadWindow("C123", "1700000000.000100", {
      cursor: "cursor-123",
    });

    const [, , , opts] = getThreadRepliesMock.mock.calls[0];
    expect(opts).toEqual({
      limit: 50,
      cursor: "cursor-123",
    });
  });

  test("returns [] when getThreadReplies throws (generic Slack API error)", async () => {
    getThreadRepliesMock.mockImplementation(async () => {
      throw new Error("Slack API error: ratelimited");
    });
    const out = await backfillThread("C123", "1700000000.000100");
    expect(out).toEqual([]);
  });

  test("rethrows channel_not_found so wrong-workspace config surfaces", async () => {
    getThreadRepliesMock.mockImplementation(async () => {
      throw new Error("Slack API error: channel_not_found");
    });
    await expect(backfillThread("C123", "1700000000.000100")).rejects.toThrow(
      /channel_not_found/,
    );
  });

  test("threads `account` through to resolveConnection", async () => {
    await backfillThread("C123", "1700000000.000100", {
      account: "team-acme",
    });
    expect(resolveConnectionMock).toHaveBeenCalledTimes(1);
    expect(resolveConnectionMock.mock.calls[0][0]).toBe("team-acme");
  });

  test("returns [] when getThreadReplies throws (auth error)", async () => {
    getThreadRepliesMock.mockImplementation(async () => {
      const err = new Error("Slack API HTTP 401");
      Object.assign(err, { status: 401 });
      throw err;
    });
    const out = await backfillThread("C123", "1700000000.000100");
    expect(out).toEqual([]);
  });

  test("returns [] when getThreadReplies throws (timeout)", async () => {
    getThreadRepliesMock.mockImplementation(async () => {
      throw new Error("ETIMEDOUT");
    });
    const out = await backfillThread("C123", "1700000000.000100");
    expect(out).toEqual([]);
  });

  test("returns [] when resolveConnection throws (missing connection)", async () => {
    resolveConnectionMock.mockImplementation(async () => {
      throw new Error("no connection available");
    });
    const out = await backfillThread("C123", "1700000000.000100");
    expect(out).toEqual([]);
    // resolveConnection failed before getThreadReplies could be reached.
    expect(getThreadRepliesMock).not.toHaveBeenCalled();
  });
});

describe("backfillDm", () => {
  beforeEach(() => {
    resolveConnectionMock.mockReset();
    resolveConnectionMock.mockImplementation(async () => undefined);
    getHistoryMock.mockReset();
    getHistoryMock.mockImplementation(async () => []);
    getThreadRepliesMock.mockReset();
    getThreadRepliesMock.mockImplementation(async () => []);
  });

  test("passes channelId through and defaults limit to 50, before undefined", async () => {
    const msg = makeMessage();
    getHistoryMock.mockImplementation(async () => [msg]);

    const out = await backfillDm("D123");

    expect(resolveConnectionMock).toHaveBeenCalledTimes(1);
    expect(getHistoryMock).toHaveBeenCalledTimes(1);
    const [conn, channel, opts] = getHistoryMock.mock.calls[0];
    expect(conn).toBeUndefined();
    expect(channel).toBe("D123");
    expect(opts).toEqual({ limit: 50, before: undefined });
    expect(out).toEqual([msg]);
  });

  test("respects explicit limit override and forwards `before` cursor", async () => {
    await backfillDm("D123", { limit: 25, before: "1700000000.000099" });
    const [, , opts] = getHistoryMock.mock.calls[0];
    expect(opts).toEqual({ limit: 25, before: "1700000000.000099" });
  });

  test("returns [] when getHistory throws (generic Slack API error)", async () => {
    getHistoryMock.mockImplementation(async () => {
      throw new Error("Slack API error: not_in_channel");
    });
    const out = await backfillDm("D123");
    expect(out).toEqual([]);
  });

  test("rethrows channel_not_found so wrong-workspace config surfaces", async () => {
    getHistoryMock.mockImplementation(async () => {
      throw new Error("Slack API error: channel_not_found");
    });
    await expect(backfillDm("D123")).rejects.toThrow(/channel_not_found/);
  });

  test("threads `account` through to resolveConnection", async () => {
    await backfillDm("D123", { account: "team-acme" });
    expect(resolveConnectionMock).toHaveBeenCalledTimes(1);
    expect(resolveConnectionMock.mock.calls[0][0]).toBe("team-acme");
  });

  test("returns [] when getHistory throws (auth error)", async () => {
    getHistoryMock.mockImplementation(async () => {
      const err = new Error("Slack API HTTP 401");
      Object.assign(err, { status: 401 });
      throw err;
    });
    const out = await backfillDm("D123");
    expect(out).toEqual([]);
  });

  test("returns [] when getHistory throws (timeout)", async () => {
    getHistoryMock.mockImplementation(async () => {
      throw new Error("ETIMEDOUT");
    });
    const out = await backfillDm("D123");
    expect(out).toEqual([]);
  });

  test("returns [] when resolveConnection throws (missing connection)", async () => {
    resolveConnectionMock.mockImplementation(async () => {
      throw new Error("no connection available");
    });
    const out = await backfillDm("D123");
    expect(out).toEqual([]);
    expect(getHistoryMock).not.toHaveBeenCalled();
  });
});
