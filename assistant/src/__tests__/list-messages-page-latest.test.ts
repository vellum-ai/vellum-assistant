/**
 * Tests for handleListMessages `page=latest` initial-page mode.
 *
 * Verifies that:
 * - `page=latest` returns the newest N messages in chronological order.
 * - `page=latest` always emits `oldestTimestamp`/`oldestMessageId` (null when empty).
 * - `beforeTimestamp` wins over `page=latest` when both are sent.
 * - Invalid `page` values return 400.
 * - The no-param and `beforeTimestamp`-only paths keep their existing shapes.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    slack: {
      teamId: "T123",
      teamUrl: "https://example.slack.com/",
    },
  }),
}));

let mockAssistantName: string | null = null;
mock.module("../daemon/identity-helpers.js", () => ({
  getAssistantName: () => mockAssistantName,
}));

import { writeSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import {
  createConversation,
  recordConversationPersistedSeq,
  setConversationProcessingStartedAt,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { messages } from "../persistence/schema/index.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  _resetStreamStateForTesting,
  getCurrentSeq,
  stampAndBuffer,
} from "../runtime/assistant-stream-state.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/**
 * Seed `count` text messages with monotonically increasing `createdAt`.
 * Inserts directly via Drizzle so timestamps are deterministic — we need
 * sequential createdAt values (1, 2, 3, ...) to verify ordering and slicing
 * without racing against `monotonicNow()` from `addMessage`.
 *
 * Returns the seeded rows in chronological order (id `msg-1` ... `msg-N`).
 */
function seedMessages(
  conversationId: string,
  count: number,
): Array<{ id: string; createdAt: number; role: string }> {
  const db = getDb();
  const seeded: Array<{ id: string; createdAt: number; role: string }> = [];
  for (let i = 1; i <= count; i++) {
    const role = i % 2 === 1 ? "user" : "assistant";
    const id = `msg-${i}`;
    const createdAt = i;
    db.insert(messages)
      .values({
        id,
        conversationId,
        role,
        content: JSON.stringify([{ type: "text", text: `message ${i}` }]),
        createdAt,
      })
      .run();
    seeded.push({ id, createdAt, role });
  }
  return seeded;
}

interface MessagePayload {
  id: string;
  role: string;
  timestamp: string;
  slackMessage?: {
    channelId: string;
    channelName?: string;
    channelTs: string;
    threadTs?: string;
    sender?: { displayName?: string; externalUserId?: string };
    messageLink?: { appUrl?: string; webUrl?: string };
    threadLink?: { appUrl?: string; webUrl?: string };
    eventKind?: "message" | "reaction";
    reaction?: {
      emoji: string;
      op: "added" | "removed";
      actorDisplayName?: string;
      targetChannelTs: string;
    };
  };
}

interface ListResponse {
  messages: MessagePayload[];
  hasMore?: boolean;
  oldestTimestamp?: number | null;
  oldestMessageId?: string | null;
  seq?: number | null;
  processing?: boolean;
}

/**
 * Stamp `count` conversation-scoped events to advance the global `seq`
 * counter, mirroring `mkEvent` in assistant-stream-state.test.ts. The
 * conversationId is irrelevant — `getCurrentSeq()` is process-global — so
 * any value works for nudging the high-water mark before a creation.
 */
function advanceGlobalSeq(count: number): void {
  for (let i = 0; i < count; i++) {
    stampAndBuffer({
      id: `seq-bump-${i}`,
      conversationId: "seq-bump-conv",
      emittedAt: new Date().toISOString(),
      message: {
        type: "assistant_text_delta",
        conversationId: "seq-bump-conv",
        text: "x",
      },
    } as AssistantEvent);
  }
}

function callList(query: Record<string, string>): ListResponse {
  return handleListMessages({
    queryParams: query,
  }) as unknown as ListResponse;
}

describe("handleListMessages page=latest", () => {
  beforeEach(() => {
    resetTables();
    _resetStreamStateForTesting();
    mockAssistantName = null;
  });

  describe("persisted seq", () => {
    test("returns the recorded persisted seq for the conversation", () => {
      /**
       * The snapshot must advertise the `seq` of the last durably-persisted
       * event so a client can align it with the `/events` stream.
       */

      // GIVEN a conversation with persisted messages
      const conv = createConversation();
      seedMessages(conv.id, 3);
      // AND the daemon has recorded a persisted seq for it
      recordConversationPersistedSeq(conv.id, 42);

      // WHEN the snapshot is fetched
      const body = callList({ conversationId: conv.id, page: "latest" });

      // THEN the response carries that seq
      expect(body.seq).toBe(42);
    });

    test("returns null seq when nothing has been persisted in-process", () => {
      /**
       * A cold conversation (or one aged out / post-restart) reports no seq,
       * signalling the client to cold-start rather than align to a stale
       * position.
       */

      // GIVEN a conversation with no recorded persisted seq
      const conv = createConversation();
      seedMessages(conv.id, 2);

      // WHEN the snapshot is fetched
      const body = callList({ conversationId: conv.id, page: "latest" });

      // THEN seq is null
      expect(body.seq).toBeNull();
    });

    test("the no-pagination path also returns the persisted seq", () => {
      /** `seq` is present on every resolved-conversation response shape. */

      // GIVEN a conversation with a recorded persisted seq
      const conv = createConversation();
      seedMessages(conv.id, 2);
      recordConversationPersistedSeq(conv.id, 7);

      // WHEN fetched with no pagination params
      const body = callList({ conversationId: conv.id });

      // THEN the seq still rides along
      expect(body.seq).toBe(7);
    });

    test("recording advances the seq monotonically and never regresses", () => {
      /**
       * Out-of-order async commits must not lower the high-water mark — the
       * `WHERE seq < ?` guard on the persist UPDATE keeps it monotonic.
       */

      // GIVEN a conversation whose persisted seq has been recorded
      const conv = createConversation();
      recordConversationPersistedSeq(conv.id, 12);

      // WHEN a lower seq is recorded (a late, out-of-order commit)
      recordConversationPersistedSeq(conv.id, 8);

      // THEN the high-water seq is unchanged
      expect(callList({ conversationId: conv.id }).seq).toBe(12);

      // AND a higher seq still advances it
      recordConversationPersistedSeq(conv.id, 20);
      expect(callList({ conversationId: conv.id }).seq).toBe(20);
    });

    test("recording ignores non-positive and non-finite seq values", () => {
      // GIVEN a freshly created conversation (no stream activity → null seed)
      const conv = createConversation();

      // WHEN non-positive / non-finite seqs are recorded
      recordConversationPersistedSeq(conv.id, 0);
      recordConversationPersistedSeq(conv.id, -3);
      recordConversationPersistedSeq(conv.id, Number.NaN);
      recordConversationPersistedSeq(conv.id, Number.POSITIVE_INFINITY);

      // THEN none take effect and seq stays null
      expect(callList({ conversationId: conv.id }).seq).toBeNull();
    });

    test("a freshly created conversation is anchored to the current global seq", () => {
      /**
       * Conversations created after some stream activity must not report a
       * null `seq` — that would force the client to cold-start with no
       * alignment baseline. They inherit the current high-water global seq
       * at creation time so the first snapshot can align with the stream.
       */

      // GIVEN the global stream has already advanced past seq 0
      advanceGlobalSeq(5);
      expect(getCurrentSeq()).toBe(5);

      // WHEN a brand-new conversation is created and its snapshot fetched
      const conv = createConversation();
      const body = callList({ conversationId: conv.id, page: "latest" });

      // THEN the snapshot is anchored to the global seq at creation time
      expect(body.seq).toBe(5);
    });

    test("a conversation created before any stream activity stays null", () => {
      /**
       * With nothing stamped this process, `getCurrentSeq()` is 0 and the
       * creation seed stores NULL (non-positive seqs aren't recorded), so the
       * snapshot legitimately reports null and the client cold-starts.
       */

      // GIVEN no events have been stamped (stream reset in beforeEach)
      expect(getCurrentSeq()).toBe(0);

      // WHEN a conversation is created and its snapshot fetched
      const conv = createConversation();
      const body = callList({ conversationId: conv.id, page: "latest" });

      // THEN seq remains null
      expect(body.seq).toBeNull();
    });
  });

  describe("processing state", () => {
    test("reports processing=true while the conversation is mid-turn", () => {
      /**
       * The authoritative processing flag lets a client recover from a
       * dropped stream: it can ask the server whether a turn is still
       * running rather than spinning forever.
       */

      // GIVEN a conversation marked as processing
      const conv = createConversation();
      seedMessages(conv.id, 1);
      setConversationProcessingStartedAt(conv.id, Date.now());

      // WHEN the snapshot is fetched
      const body = callList({ conversationId: conv.id, page: "latest" });

      // THEN it reports the conversation is processing
      expect(body.processing).toBe(true);
    });

    test("reports processing=false when the conversation is idle", () => {
      // GIVEN an idle conversation (processing_started_at is null)
      const conv = createConversation();
      seedMessages(conv.id, 2);

      // WHEN the snapshot is fetched
      const body = callList({ conversationId: conv.id, page: "latest" });

      // THEN it reports the conversation is not processing
      expect(body.processing).toBe(false);
    });

    test("the no-pagination path also reports processing state", () => {
      /** `processing` is present on every resolved-conversation shape. */

      // GIVEN a processing conversation
      const conv = createConversation();
      seedMessages(conv.id, 1);
      setConversationProcessingStartedAt(conv.id, Date.now());

      // WHEN fetched with no pagination params
      const body = callList({ conversationId: conv.id });

      // THEN processing rides along
      expect(body.processing).toBe(true);
    });

    test("an unresolved conversationKey reports processing=false (page=latest)", () => {
      // WHEN a never-created key is fetched with the stable contract
      const body = callList({
        conversationKey: "no-such-key",
        page: "latest",
      });

      // THEN it cannot be processing
      expect(body.processing).toBe(false);
    });
  });

  test("page=latest with no limit returns all messages chronologically", () => {
    const conv = createConversation();
    seedMessages(conv.id, 120);

    const body = callList({ conversationId: conv.id, page: "latest" });

    expect(body.messages).toHaveLength(120);
    expect(body.messages[0].id).toBe("msg-1");
    expect(body.messages[119].id).toBe("msg-120");
    expect(body.hasMore).toBe(false);
    expect(body.oldestTimestamp).toBe(1);
    expect(body.oldestMessageId).toBe("msg-1");
  });

  test("page=latest&limit=50 with 120 seeded messages returns newest 50 chronologically", () => {
    const conv = createConversation();
    seedMessages(conv.id, 120);

    const body = callList({
      conversationId: conv.id,
      page: "latest",
      limit: "50",
    });

    expect(body.messages).toHaveLength(50);
    // newest 50 are ids 71..120 (1..120 seeded)
    expect(body.messages[0].id).toBe("msg-71");
    expect(body.messages[49].id).toBe("msg-120");
    expect(body.hasMore).toBe(true);
    expect(body.oldestTimestamp).toBe(71);
    expect(body.oldestMessageId).toBe("msg-71");
  });

  test("page=latest&limit=50 with 10 seeded messages returns all 10 with hasMore=false", () => {
    const conv = createConversation();
    seedMessages(conv.id, 10);

    const body = callList({
      conversationId: conv.id,
      page: "latest",
      limit: "50",
    });

    expect(body.messages).toHaveLength(10);
    expect(body.messages[0].id).toBe("msg-1");
    expect(body.messages[9].id).toBe("msg-10");
    expect(body.hasMore).toBe(false);
    expect(body.oldestTimestamp).toBe(1);
    expect(body.oldestMessageId).toBe("msg-1");
  });

  test("beforeTimestamp wins when combined with page=latest", () => {
    const conv = createConversation();
    seedMessages(conv.id, 120);

    // beforeTimestamp=100 + limit=50 should return msgs 50..99 (the 50 messages
    // immediately older than ts=100), regardless of the page=latest signal.
    const combinedBody = callList({
      conversationId: conv.id,
      page: "latest",
      limit: "50",
      beforeTimestamp: "100",
    });

    const beforeOnlyBody = callList({
      conversationId: conv.id,
      limit: "50",
      beforeTimestamp: "100",
    });

    expect(combinedBody.messages.map((m) => m.id)).toEqual(
      beforeOnlyBody.messages.map((m) => m.id),
    );
    expect(combinedBody.hasMore).toBe(beforeOnlyBody.hasMore);
    expect(combinedBody.oldestTimestamp).toBe(beforeOnlyBody.oldestTimestamp);
    expect(combinedBody.oldestMessageId).toBe(beforeOnlyBody.oldestMessageId);
    // Sanity-check the older-page slice itself.
    expect(combinedBody.messages).toHaveLength(50);
    expect(combinedBody.messages[0].id).toBe("msg-50");
    expect(combinedBody.messages[49].id).toBe("msg-99");
  });

  test("page=latest on empty conversation returns null pagination metadata", () => {
    const conv = createConversation();

    const body = callList({ conversationId: conv.id, page: "latest" });

    expect(body.messages).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.oldestTimestamp).toBeNull();
    expect(body.oldestMessageId).toBeNull();
  });

  test("messages expose Slack message and thread links from slackMeta", () => {
    const conv = createConversation();
    const db = getDb();
    db.insert(messages)
      .values({
        id: "msg-slack",
        conversationId: conv.id,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Slack reply" }]),
        metadata: JSON.stringify({
          slackMeta: writeSlackMetadata({
            source: "slack",
            channelId: "C123ABCDEF",
            channelName: "engineering",
            channelTs: "1710000000.000200",
            threadTs: "1710000000.000100",
            displayName: "Alice",
            actorExternalUserId: "U_ALICE",
            eventKind: "message",
          }),
        }),
        createdAt: 1,
      })
      .run();

    const body = callList({ conversationId: conv.id, page: "latest" });

    expect(body.messages[0].slackMessage).toEqual({
      channelId: "C123ABCDEF",
      channelName: "engineering",
      channelTs: "1710000000.000200",
      threadTs: "1710000000.000100",
      sender: {
        displayName: "Alice",
        externalUserId: "U_ALICE",
      },
      messageLink: {
        appUrl:
          "slack://channel?team=T123&id=C123ABCDEF&message=1710000000.000200",
        webUrl:
          "https://example.slack.com/archives/C123ABCDEF/p1710000000000200?thread_ts=1710000000.000100&cid=C123ABCDEF",
      },
      threadLink: {
        appUrl:
          "slack://channel?team=T123&id=C123ABCDEF&message=1710000000.000100",
        webUrl:
          "https://example.slack.com/archives/C123ABCDEF/p1710000000000100",
      },
      eventKind: "message",
    });
  });

  test("top-level Slack messages with matching threadTs use plain permalinks", () => {
    const conv = createConversation();
    const db = getDb();
    db.insert(messages)
      .values({
        id: "msg-slack-top-level",
        conversationId: conv.id,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Slack top-level" }]),
        metadata: JSON.stringify({
          slackMeta: writeSlackMetadata({
            source: "slack",
            channelId: "C123ABCDEF",
            channelName: "engineering",
            channelTs: "1710000000.000200",
            threadTs: "1710000000.000200",
            displayName: "Alice",
            actorExternalUserId: "U_ALICE",
            eventKind: "message",
          }),
        }),
        createdAt: 1,
      })
      .run();

    const body = callList({ conversationId: conv.id, page: "latest" });

    expect(body.messages[0].slackMessage).toEqual({
      channelId: "C123ABCDEF",
      channelName: "engineering",
      channelTs: "1710000000.000200",
      threadTs: "1710000000.000200",
      sender: {
        displayName: "Alice",
        externalUserId: "U_ALICE",
      },
      messageLink: {
        appUrl:
          "slack://channel?team=T123&id=C123ABCDEF&message=1710000000.000200",
        webUrl:
          "https://example.slack.com/archives/C123ABCDEF/p1710000000000200",
      },
      eventKind: "message",
    });
  });

  test("assistant Slack messages without stored sender use the assistant name", () => {
    mockAssistantName = "Nova";
    const conv = createConversation();
    const db = getDb();
    db.insert(messages)
      .values({
        id: "msg-slack-assistant",
        conversationId: conv.id,
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Slack response" }]),
        metadata: JSON.stringify({
          slackMeta: writeSlackMetadata({
            source: "slack",
            channelId: "C123ABCDEF",
            channelTs: "1710000000.000300",
            eventKind: "message",
          }),
        }),
        createdAt: 1,
      })
      .run();

    const body = callList({ conversationId: conv.id, page: "latest" });

    expect(body.messages[0].slackMessage?.sender).toEqual({
      displayName: "Nova",
    });
  });

  test("user Slack messages without stored sender do not use the assistant name", () => {
    mockAssistantName = "Nova";
    const conv = createConversation();
    const db = getDb();
    db.insert(messages)
      .values({
        id: "msg-slack-user",
        conversationId: conv.id,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Slack request" }]),
        metadata: JSON.stringify({
          slackMeta: writeSlackMetadata({
            source: "slack",
            channelId: "C123ABCDEF",
            channelTs: "1710000000.000300",
            eventKind: "message",
          }),
        }),
        createdAt: 1,
      })
      .run();

    const body = callList({ conversationId: conv.id, page: "latest" });

    expect(body.messages[0].slackMessage?.sender).toBeUndefined();
  });

  test("page=latest on unresolved conversationKey returns null metadata contract", () => {
    const body = callList({
      conversationKey: "no-such-key",
      page: "latest",
    });

    expect(body.messages).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.oldestTimestamp).toBeNull();
    expect(body.oldestMessageId).toBeNull();
  });

  test("no-page GET on unresolved conversationKey keeps minimal shape", () => {
    const body = callList({ conversationKey: "no-such-key" });

    expect(body.messages).toEqual([]);
    expect("hasMore" in body).toBe(false);
    expect("oldestTimestamp" in body).toBe(false);
    expect("oldestMessageId" in body).toBe(false);
  });

  test("page=invalid throws BadRequestError", () => {
    const conv = createConversation();

    expect(() =>
      handleListMessages({
        queryParams: { conversationId: conv.id, page: "invalid" },
      }),
    ).toThrow(BadRequestError);
    expect(() =>
      handleListMessages({
        queryParams: { conversationId: conv.id, page: "invalid" },
      }),
    ).toThrow("page must be 'latest' when provided");
  });

  test("no-param GET returns full history without pagination metadata", () => {
    const conv = createConversation();
    seedMessages(conv.id, 5);

    const body = callList({ conversationId: conv.id });

    expect(body.messages).toHaveLength(5);
    expect(body.messages[0].id).toBe("msg-1");
    expect(body.messages[4].id).toBe("msg-5");
    // Regression: the no-param shape must NOT include pagination metadata.
    expect("hasMore" in body).toBe(false);
    expect("oldestTimestamp" in body).toBe(false);
    expect("oldestMessageId" in body).toBe(false);
  });

  test("beforeTimestamp-only GET keeps existing conditional-metadata shape (no results)", () => {
    const conv = createConversation();
    seedMessages(conv.id, 5);

    // beforeTimestamp before all seeded rows => no results, metadata omitted.
    const body = callList({
      conversationId: conv.id,
      limit: "10",
      beforeTimestamp: "0",
    });

    expect(body.messages).toEqual([]);
    expect(body.hasMore).toBe(false);
    // Existing contract: omit metadata when no rows. Must NOT regress to null.
    expect("oldestTimestamp" in body).toBe(false);
    expect("oldestMessageId" in body).toBe(false);
  });

  test("beforeTimestamp-only GET keeps existing conditional-metadata shape (with results)", () => {
    const conv = createConversation();
    seedMessages(conv.id, 5);

    const body = callList({
      conversationId: conv.id,
      limit: "10",
      beforeTimestamp: "100",
    });

    expect(body.messages).toHaveLength(5);
    expect(body.hasMore).toBe(false);
    expect(body.oldestTimestamp).toBe(1);
    expect(body.oldestMessageId).toBe("msg-1");
  });
});
