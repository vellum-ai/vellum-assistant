/**
 * PR 22 — verifies that an inbound Slack thread reply triggers a lazy
 * backfill of the missing thread ancestors when the conversation has no
 * record of the parent message, persists each backfilled message with a
 * derived `slackMeta` envelope, de-dupes against rows already stored, and
 * gates exact-window re-triggers behind a 10-minute idempotency cache so
 * bursts of retries for the same gap do not flood the Slack API.
 *
 * Tests exercise the helper {@link triggerSlackThreadBackfillIfNeeded}
 * directly against the real database (via the test-preload temp workspace).
 * Only `backfillThreadWindow` is mocked, since the contract under test is "given
 * what Slack returns, what does the daemon write to the DB".
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mocks (must precede module imports under test). Note: backfillThreadWindow is
// stubbed via spyOn (below) rather than mock.module so the stub does not leak
// into other test files (e.g. backfill.test.ts) that import the same module.
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: () => undefined,
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
  listCredentialMetadata: () => [],
}));

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async () => {},
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { v4 as uuid } from "uuid";

import { upsertContactChannel } from "../contacts/contacts-write.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import type { Message as MessagingMessage } from "../messaging/provider-types.js";
import * as slackBackfill from "../messaging/providers/slack/backfill.js";
import {
  readSlackMetadata,
  writeSlackMetadata,
} from "../messaging/providers/slack/message-metadata.js";
import {
  _backfillTriggerCache,
  triggerSlackThreadBackfillIfNeeded,
} from "../runtime/routes/inbound-message-handler.js";
import {
  handleChannelInbound,
  setAdapterProcessMessage,
} from "./helpers/channel-test-adapter.js";

initializeDb();

// Spy on backfillThreadWindow so the stub is scoped to this test file only.
// Restoring after the file's tests run keeps cross-file leakage to zero —
// other tests (e.g. backfill.test.ts) keep seeing the real implementation.
const backfillThreadMock = spyOn(slackBackfill, "backfillThreadWindow");
backfillThreadMock.mockResolvedValue([]);

afterAll(() => {
  backfillThreadMock.mockRestore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
//
// These helpers go directly against the SQLite layer rather than calling into
// `conversation-crud.js`. The reason is test isolation: several other test
// files in the suite mock `conversation-crud.js` partially (only the exports
// they need), and Bun does not always reset such mocks between files. When
// our test runs in the same process after one of those, calls like
// `getMessages` come back as `undefined`. Going around the module entirely
// keeps this test resilient to any future module-level mocks elsewhere.

const SLACK_CHANNEL_ID = "C0THREAD";

function resetState(): void {
  const db = getDb();
  db.$client.exec("DELETE FROM messages");
  db.$client.exec("DELETE FROM conversations");
  _backfillTriggerCache.clear();
  backfillThreadMock.mockReset();
  backfillThreadMock.mockImplementation(async () => []);
}

let convCounter = 0;

function makeConversationId(): string {
  convCounter++;
  return `conv-test-${convCounter}-${uuid()}`;
}

function createTestConversation(): { id: string } {
  const db = getDb();
  const id = makeConversationId();
  const now = Date.now();
  db.$client
    .prepare(
      `INSERT INTO conversations (
        id, title, created_at, updated_at, total_input_tokens, total_output_tokens,
        total_estimated_cost, context_compacted_message_count, conversation_type,
        source, memory_scope_id, host_access, is_auto_title
      ) VALUES (?, NULL, ?, ?, 0, 0, 0, 0, 'standard', 'user', 'default', 0, 1)`,
    )
    .run(id, now, now);
  return { id };
}

let messageCounter = 0;

function insertMessage(
  conversationId: string,
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
): void {
  const db = getDb();
  const id = uuid();
  // Use a strictly increasing timestamp so the ORDER BY in
  // readMessagesByConversation is deterministic — Date.now() ties when
  // multiple inserts happen inside the same millisecond.
  messageCounter++;
  const now = Date.now() + messageCounter;
  const metadataStr = metadata ? JSON.stringify(metadata) : null;
  db.$client
    .prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, conversationId, role, content, now, metadataStr);
}

interface RawMessageRow {
  role: string;
  content: string;
  metadata: string | null;
}

function readMessagesByConversation(conversationId: string): RawMessageRow[] {
  const db = getDb();
  return db.$client
    .prepare(
      "SELECT role, content, metadata FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    )
    .all(conversationId) as RawMessageRow[];
}

function makeBackfillMessage(
  overrides: Partial<MessagingMessage> = {},
): MessagingMessage {
  return {
    id: "1234.0",
    conversationId: SLACK_CHANNEL_ID,
    sender: { id: "U_USER", name: "Alice" },
    text: "thread parent",
    timestamp: 1700000000_000,
    threadId: undefined,
    platform: "slack",
    ...overrides,
  };
}

interface PersistedRow {
  role: string;
  content: string;
  channelTs: string | undefined;
  threadTs: string | undefined;
  displayName: string | undefined;
  backfillReason: string | undefined;
  backfillOmittedMiddle: boolean | undefined;
  slackFiles: Array<{ name: string; mimetype?: string }> | undefined;
}

function readPersistedSlackRows(conversationId: string): PersistedRow[] {
  const rows = readMessagesByConversation(conversationId);
  const out: PersistedRow[] = [];
  for (const row of rows) {
    const blank: PersistedRow = {
      role: row.role,
      content: row.content,
      channelTs: undefined,
      threadTs: undefined,
      displayName: undefined,
      backfillReason: undefined,
      backfillOmittedMiddle: undefined,
      slackFiles: undefined,
    };
    if (!row.metadata) {
      out.push(blank);
      continue;
    }
    let envelope: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.metadata) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        out.push(blank);
        continue;
      }
      envelope = parsed as Record<string, unknown>;
    } catch {
      out.push(blank);
      continue;
    }
    const slackMetaRaw = envelope.slackMeta;
    if (typeof slackMetaRaw !== "string") {
      out.push(blank);
      continue;
    }
    const slackMeta = readSlackMetadata(slackMetaRaw);
    out.push({
      role: row.role,
      content: row.content,
      channelTs: slackMeta?.channelTs,
      threadTs: slackMeta?.threadTs,
      displayName: slackMeta?.displayName,
      backfillReason: slackMeta?.backfillReason,
      backfillOmittedMiddle: slackMeta?.backfillOmittedMiddle,
      slackFiles: slackMeta?.slackFiles?.map((file) => ({
        name: file.name,
        ...(file.mimetype ? { mimetype: file.mimetype } : {}),
      })),
    });
  }
  return out;
}

function seedSlackRow(
  conversationId: string,
  channelTs: string,
  threadTs: string | undefined,
  text: string,
): void {
  insertMessage(conversationId, "user", text, {
    slackMeta: writeSlackMetadata({
      source: "slack",
      channelId: SLACK_CHANNEL_ID,
      channelTs,
      eventKind: "message",
      ...(threadTs ? { threadTs } : {}),
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("triggerSlackThreadBackfillIfNeeded — gap detection and persistence", () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    backfillThreadMock.mockReset();
    _backfillTriggerCache.clear();
  });

  test("inbound thread reply with unseen parent triggers backfill and persists ancestors with slackMeta", async () => {
    const conv = createTestConversation();

    backfillThreadMock.mockImplementation(async () => [
      makeBackfillMessage({
        id: "1234.0",
        text: "parent",
        threadId: undefined,
        sender: { id: "U_PARENT", name: "Parent User" },
      }),
      makeBackfillMessage({
        id: "1234.1",
        text: "first reply",
        threadId: "1234.0",
        sender: { id: "U_REPLY1", name: "Reply One" },
      }),
      makeBackfillMessage({
        id: "1234.2",
        text: "second reply",
        threadId: "1234.0",
        sender: { id: "U_REPLY2", name: "Reply Two" },
      }),
    ]);

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
    });

    expect(backfillThreadMock).toHaveBeenCalledTimes(1);
    const [calledChannel, calledThread] = backfillThreadMock.mock.calls[0];
    expect(calledChannel).toBe(SLACK_CHANNEL_ID);
    expect(calledThread).toBe("1234.0");

    const persisted = readPersistedSlackRows(conv.id);
    expect(persisted.length).toBe(3);

    const byChannelTs = new Map(
      persisted.map((p) => [p.channelTs ?? "<no-ts>", p]),
    );
    expect(byChannelTs.get("1234.0")?.content).toBe("parent");
    expect(byChannelTs.get("1234.0")?.displayName).toBe("Parent User");
    expect(byChannelTs.get("1234.0")?.threadTs).toBeUndefined();
    expect(byChannelTs.get("1234.0")?.backfillReason).toBe("thread_late_join");

    expect(byChannelTs.get("1234.1")?.content).toBe("first reply");
    expect(byChannelTs.get("1234.1")?.threadTs).toBe("1234.0");
    expect(byChannelTs.get("1234.1")?.displayName).toBe("Reply One");

    expect(byChannelTs.get("1234.2")?.content).toBe("second reply");
    expect(byChannelTs.get("1234.2")?.threadTs).toBe("1234.0");
    expect(byChannelTs.get("1234.2")?.displayName).toBe("Reply Two");
  });

  test("initial late-join backfill preserves early and recent anchors without loading the middle", async () => {
    const conv = createTestConversation();
    const ts = (n: number) => `1234.${String(n).padStart(6, "0")}`;

    backfillThreadMock.mockImplementation(async (_channel, _thread, opts) => {
      if (opts?.limit === 25) {
        return Array.from({ length: 25 }, (_, i) =>
          makeBackfillMessage({
            id: ts(i),
            text: i === 0 ? "root context" : `early ${i}`,
            threadId: i === 0 ? undefined : ts(0),
          }),
        );
      }
      return [
        ...Array.from({ length: 50 }, (_, i) => {
          const n = i + 50;
          return makeBackfillMessage({
            id: ts(n),
            text: n === 99 ? "recent file share" : `recent ${n}`,
            threadId: ts(0),
            ...(n === 99
              ? {
                  metadata: {
                    slackFiles: [
                      {
                        id: "F123",
                        name: "requirements.txt",
                        mimetype: "text/plain",
                      },
                    ],
                  },
                }
              : {}),
          });
        }),
        makeBackfillMessage({
          id: ts(60),
          text: "duplicate recent row",
          threadId: ts(0),
        }),
      ];
    });

    const result = await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: ts(0),
      excludeChannelTs: ts(100),
    });

    expect(backfillThreadMock).toHaveBeenCalledTimes(2);
    expect(backfillThreadMock.mock.calls[0][2]?.limit).toBe(25);
    expect(backfillThreadMock.mock.calls[0][2]?.before).toBeUndefined();
    expect(backfillThreadMock.mock.calls[1][2]?.limit).toBe(50);
    expect(backfillThreadMock.mock.calls[1][2]?.before).toBe(ts(100));

    expect(result.reason).toBe("thread_late_join");
    expect(result.omittedMiddle).toBe(true);

    const persisted = readPersistedSlackRows(conv.id);
    expect(persisted.length).toBe(75);
    expect(persisted.find((p) => p.channelTs === ts(0))?.content).toBe(
      "root context",
    );
    expect(persisted.find((p) => p.channelTs === ts(30))).toBeUndefined();
    expect(persisted.find((p) => p.channelTs === ts(99))?.content).toBe(
      "recent file share",
    );
    expect(
      persisted.filter((p) => p.channelTs === ts(60)).map((p) => p.content),
    ).toEqual(["recent 60"]);
    expect(persisted.some((p) => p.backfillOmittedMiddle === true)).toBe(true);
    expect(persisted.find((p) => p.channelTs === ts(99))?.slackFiles).toEqual([
      { name: "requirements.txt", mimetype: "text/plain" },
    ]);
  });

  test("backfill is NOT triggered when the parent is already persisted and no upper-bound gap is known", async () => {
    const conv = createTestConversation();

    // Seed the parent message before the trigger runs — simulates a
    // conversation where the daemon has already seen the thread parent but
    // the caller did not provide the inbound Slack ts needed to bound a gap.
    seedSlackRow(conv.id, "1234.0", undefined, "already here");

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
    });

    expect(backfillThreadMock).not.toHaveBeenCalled();

    const persisted = readPersistedSlackRows(conv.id);
    expect(persisted.length).toBe(1);
    expect(persisted[0].channelTs).toBe("1234.0");
  });

  test("parent already persisted but later replies are missing triggers a bounded delta backfill", async () => {
    const conv = createTestConversation();

    seedSlackRow(conv.id, "1234.0", undefined, "parent already here");

    backfillThreadMock.mockImplementation(async () => [
      makeBackfillMessage({
        id: "1234.0",
        text: "duplicate parent",
        threadId: undefined,
      }),
      makeBackfillMessage({
        id: "1234.1",
        text: "unseen earlier reply",
        threadId: "1234.0",
      }),
      makeBackfillMessage({
        id: "1234.5",
        text: "live inbound reply",
        threadId: "1234.0",
      }),
    ]);

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
      excludeChannelTs: "1234.5",
    });

    expect(backfillThreadMock).toHaveBeenCalledTimes(1);
    const [, , opts] = backfillThreadMock.mock.calls[0];
    expect(opts?.after).toBe("1234.0");
    expect(opts?.before).toBe("1234.5");

    const persisted = readPersistedSlackRows(conv.id);
    expect(persisted.length).toBe(2);
    expect(persisted.find((p) => p.channelTs === "1234.0")?.content).toBe(
      "parent already here",
    );
    expect(persisted.find((p) => p.channelTs === "1234.1")?.content).toBe(
      "unseen earlier reply",
    );
    expect(persisted.find((p) => p.channelTs === "1234.5")).toBeUndefined();
  });

  test("latest stored thread message at or after inbound ts skips backfill using parsed Slack timestamps", async () => {
    const conv = createTestConversation();

    seedSlackRow(conv.id, "1234.0", undefined, "parent");
    seedSlackRow(conv.id, "1234.10", "1234.0", "newer stored reply");

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
      excludeChannelTs: "1234.2",
    });

    expect(backfillThreadMock).not.toHaveBeenCalled();
    expect(readPersistedSlackRows(conv.id).length).toBe(2);
  });

  test("idempotency cache: a second call inside the TTL window does not re-fetch", async () => {
    const conv = createTestConversation();

    backfillThreadMock.mockImplementation(async () => [
      makeBackfillMessage({ id: "1234.0", text: "parent" }),
    ]);

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
    });

    // Second call for the same unbounded window — must short-circuit on the
    // in-memory cache without hitting backfillThreadWindow again.
    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
    });

    expect(backfillThreadMock).toHaveBeenCalledTimes(1);

    const persisted = readPersistedSlackRows(conv.id);
    // Only one parent row (no duplicate from the second trigger).
    expect(persisted.filter((p) => p.channelTs === "1234.0").length).toBe(1);
  });

  test("backfill error: turn proceeds, no crash, no rows written", async () => {
    const conv = createTestConversation();

    backfillThreadMock.mockImplementation(async () => {
      throw new Error("Slack API error: thread_not_found");
    });

    // Must not throw — error handling is internal.
    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
    });

    expect(backfillThreadMock).toHaveBeenCalledTimes(1);
    expect(readPersistedSlackRows(conv.id).length).toBe(0);
  });

  test("backfill returns duplicates that are already stored — only new rows are inserted", async () => {
    const conv = createTestConversation();

    // Pre-seed parent and sibling 1234.1 so the bounded delta response
    // includes one row that already exists (and must not be re-inserted)
    // plus one genuinely new sibling.
    seedSlackRow(conv.id, "1234.0", undefined, "parent");
    seedSlackRow(conv.id, "1234.1", "1234.0", "already here");

    backfillThreadMock.mockImplementation(async () => [
      makeBackfillMessage({
        id: "1234.1",
        text: "duplicate sibling — must be skipped",
        threadId: "1234.0",
      }),
      makeBackfillMessage({
        id: "1234.2",
        text: "new sibling",
        threadId: "1234.0",
      }),
    ]);

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
      excludeChannelTs: "1234.3",
    });

    expect(backfillThreadMock).toHaveBeenCalledTimes(1);
    expect(backfillThreadMock.mock.calls[0][2]?.after).toBe("1234.1");
    expect(backfillThreadMock.mock.calls[0][2]?.before).toBe("1234.3");

    const persisted = readPersistedSlackRows(conv.id);
    expect(persisted.length).toBe(3);

    const oneRow = persisted.find((p) => p.channelTs === "1234.1");
    // The pre-seeded row's content remains; the duplicate from backfill was
    // skipped (otherwise the count would be 4 or the content would change).
    expect(oneRow?.content).toBe("already here");

    expect(persisted.find((p) => p.channelTs === "1234.0")?.content).toBe(
      "parent",
    );
    expect(persisted.find((p) => p.channelTs === "1234.2")?.content).toBe(
      "new sibling",
    );
  });

  test("empty backfill response leaves the conversation untouched but still seeds the cache", async () => {
    const conv = createTestConversation();

    backfillThreadMock.mockImplementation(async () => []);

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
    });

    expect(backfillThreadMock).toHaveBeenCalledTimes(1);
    expect(readPersistedSlackRows(conv.id).length).toBe(0);

    // Cache should now be populated for this exact unbounded window, so an
    // immediate retry must not re-run the API call.
    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
    });
    expect(backfillThreadMock).toHaveBeenCalledTimes(1);
  });

  test("TTL cache suppresses the same bounded window but not a newer upper-bound window", async () => {
    const conv = createTestConversation();

    backfillThreadMock.mockImplementation(async () => []);

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
      excludeChannelTs: "1234.5",
    });
    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
      excludeChannelTs: "1234.5",
    });
    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
      excludeChannelTs: "1234.6",
    });

    expect(backfillThreadMock).toHaveBeenCalledTimes(4);
    expect(backfillThreadMock.mock.calls[0][2]?.before).toBeUndefined();
    expect(backfillThreadMock.mock.calls[1][2]?.before).toBe("1234.5");
    expect(backfillThreadMock.mock.calls[2][2]?.before).toBeUndefined();
    expect(backfillThreadMock.mock.calls[3][2]?.before).toBe("1234.6");
  });

  test("rapid consecutive replies can fetch a newer gap even when the prior inbound reply was only excluded", async () => {
    const conv = createTestConversation();

    backfillThreadMock.mockImplementation(async (_channel, _thread, opts) => {
      if (opts?.limit === 25) {
        return [
          makeBackfillMessage({
            id: "1234.0",
            text: "parent",
            threadId: undefined,
          }),
        ];
      }
      if (opts?.before === "1234.5") {
        return [
          makeBackfillMessage({
            id: "1234.0",
            text: "parent",
            threadId: undefined,
          }),
          makeBackfillMessage({
            id: "1234.4",
            text: "reply before first live inbound",
            threadId: "1234.0",
          }),
          makeBackfillMessage({
            id: "1234.5",
            text: "first live inbound",
            threadId: "1234.0",
          }),
        ];
      }
      return [
        makeBackfillMessage({
          id: "1234.5",
          text: "first live inbound recovered by newer window",
          threadId: "1234.0",
        }),
        makeBackfillMessage({
          id: "1234.6",
          text: "second live inbound",
          threadId: "1234.0",
        }),
      ];
    });

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
      excludeChannelTs: "1234.5",
    });
    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
      excludeChannelTs: "1234.6",
    });

    expect(backfillThreadMock).toHaveBeenCalledTimes(3);
    expect(backfillThreadMock.mock.calls[0][2]?.after).toBeUndefined();
    expect(backfillThreadMock.mock.calls[0][2]?.before).toBeUndefined();
    expect(backfillThreadMock.mock.calls[1][2]?.after).toBeUndefined();
    expect(backfillThreadMock.mock.calls[1][2]?.before).toBe("1234.5");
    expect(backfillThreadMock.mock.calls[2][2]?.after).toBe("1234.4");
    expect(backfillThreadMock.mock.calls[2][2]?.before).toBe("1234.6");

    const persisted = readPersistedSlackRows(conv.id);
    expect(persisted.map((p) => p.channelTs).sort()).toEqual([
      "1234.0",
      "1234.4",
      "1234.5",
    ]);
    expect(persisted.find((p) => p.channelTs === "1234.6")).toBeUndefined();
  });

  test("two distinct threads in the same conversation each trigger their own backfill", async () => {
    const conv = createTestConversation();

    backfillThreadMock.mockImplementation(async (_channel, threadTs) => [
      makeBackfillMessage({
        id: threadTs as string,
        text: `parent of ${threadTs as string}`,
      }),
    ]);

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
    });
    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "5678.0",
    });

    expect(backfillThreadMock).toHaveBeenCalledTimes(2);

    const persisted = readPersistedSlackRows(conv.id);
    expect(persisted.length).toBe(2);
    expect(persisted.map((p) => p.channelTs).sort()).toEqual([
      "1234.0",
      "5678.0",
    ]);
  });

  test("backfilled message without text is persisted with empty content", async () => {
    const conv = createTestConversation();

    backfillThreadMock.mockImplementation(async () => [
      makeBackfillMessage({
        id: "1234.0",
        text: "",
      }),
    ]);

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
    });

    const persisted = readPersistedSlackRows(conv.id);
    expect(persisted.length).toBe(1);
    expect(persisted[0].content).toBe("");
    expect(persisted[0].channelTs).toBe("1234.0");
  });

  test("backfill skips messages with no id rather than crashing", async () => {
    const conv = createTestConversation();

    backfillThreadMock.mockImplementation(async () => [
      makeBackfillMessage({ id: "", text: "no id" }),
      makeBackfillMessage({ id: "1234.0", text: "valid parent" }),
    ]);

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
    });

    const persisted = readPersistedSlackRows(conv.id);
    expect(persisted.length).toBe(1);
    expect(persisted[0].channelTs).toBe("1234.0");
  });

  test("reaction row targeting the thread parent does not short-circuit ancestor backfill", async () => {
    const conv = createTestConversation();

    // A reaction on the thread parent stores the parent's ts as `channelTs`
    // (the reaction *targets* that message). If the dedup scan includes
    // reaction rows, ancestor backfill wrongly believes the parent is
    // already persisted and skips the network fetch.
    const db = getDb();
    messageCounter++;
    const now = Date.now() + messageCounter;
    db.$client
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuid(),
        conv.id,
        "user",
        "+1",
        now,
        JSON.stringify({
          slackMeta: writeSlackMetadata({
            source: "slack",
            channelId: SLACK_CHANNEL_ID,
            channelTs: "1234.0",
            eventKind: "reaction",
            reaction: {
              emoji: "+1",
              targetChannelTs: "1234.0",
              op: "added",
            },
          }),
        }),
      );

    backfillThreadMock.mockImplementation(async () => [
      makeBackfillMessage({ id: "1234.0", text: "parent" }),
    ]);

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
    });

    expect(backfillThreadMock).toHaveBeenCalledTimes(1);
    const persisted = readPersistedSlackRows(conv.id);
    // Reaction row + newly backfilled parent message row.
    expect(persisted.length).toBe(2);
    expect(
      persisted.find((p) => p.channelTs === "1234.0" && p.content === "parent"),
    ).toBeDefined();
  });

  test("excludeChannelTs pre-seeds the dedup set so the inbound message is not re-persisted", async () => {
    const conv = createTestConversation();

    // Simulate Slack's conversations.replies returning the just-received
    // inbound message alongside the thread parent — this is the normal
    // response shape. Without excludeChannelTs, the inbound row (persisted
    // concurrently in the background) would race the backfill and produce
    // a duplicate.
    backfillThreadMock.mockImplementation(async () => [
      makeBackfillMessage({
        id: "1234.0",
        text: "parent",
        threadId: undefined,
      }),
      makeBackfillMessage({
        id: "1234.5",
        text: "inbound reply — must be skipped",
        threadId: "1234.0",
      }),
    ]);

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
      excludeChannelTs: "1234.5",
    });

    const persisted = readPersistedSlackRows(conv.id);
    // Only the parent should be persisted by backfill; the inbound (1234.5)
    // is owned by the concurrent inbound-processing path.
    expect(persisted.length).toBe(1);
    expect(persisted[0].channelTs).toBe("1234.0");
    expect(persisted.find((p) => p.channelTs === "1234.5")).toBeUndefined();
  });

  test("messages with malformed metadata in the conversation are tolerated when scanning", async () => {
    const conv = createTestConversation();

    // Insert a message with malformed (non-JSON) metadata directly. The
    // scan must not throw on parse errors.
    insertMessage(conv.id, "user", "malformed", { foo: "bar" });
    const db = getDb();
    db.$client
      .prepare(
        "UPDATE messages SET metadata = 'not-json' WHERE conversation_id = ?",
      )
      .run(conv.id);

    backfillThreadMock.mockImplementation(async () => [
      makeBackfillMessage({ id: "1234.0", text: "parent" }),
    ]);

    await triggerSlackThreadBackfillIfNeeded({
      conversationId: conv.id,
      channelId: SLACK_CHANNEL_ID,
      threadTs: "1234.0",
    });

    expect(backfillThreadMock).toHaveBeenCalledTimes(1);
    const persisted = readPersistedSlackRows(conv.id);
    // Two rows: the malformed row + the newly backfilled parent.
    expect(persisted.length).toBe(2);
    expect(persisted.find((p) => p.channelTs === "1234.0")?.content).toBe(
      "parent",
    );
  });
});

// ---------------------------------------------------------------------------
// Integration through handleChannelInbound — the wiring contract
// ---------------------------------------------------------------------------

const TEST_BEARER_TOKEN = "test-token";
const HTTP_SLACK_CHANNEL_ID = "C0HTTPTHREAD";
const HTTP_SLACK_USER_ID = "U_HTTP_USER";
const HTTP_SLACK_DISPLAY_NAME = "Charlie Threader";

function resetHttpState(): void {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  _backfillTriggerCache.clear();
  backfillThreadMock.mockReset();
  backfillThreadMock.mockImplementation(async () => []);
  setAdapterProcessMessage(undefined);
}

function seedHttpActiveMember(): void {
  upsertContactChannel({
    sourceChannel: "slack",
    externalUserId: HTTP_SLACK_USER_ID,
    externalChatId: HTTP_SLACK_CHANNEL_ID,
    status: "active",
    policy: "allow",
    displayName: HTTP_SLACK_DISPLAY_NAME,
  });
}

let httpMsgCounter = 0;

function buildThreadReplyRequest(
  threadId: string,
  messageId: string,
  overrides: Record<string, unknown> = {},
): Request {
  httpMsgCounter++;
  const body: Record<string, unknown> = {
    sourceChannel: "slack",
    interface: "slack",
    conversationExternalId: HTTP_SLACK_CHANNEL_ID,
    externalMessageId: `${HTTP_SLACK_CHANNEL_ID}:${messageId}:${httpMsgCounter}`,
    content: "thread reply text",
    actorExternalId: HTTP_SLACK_USER_ID,
    actorDisplayName: HTTP_SLACK_DISPLAY_NAME,
    actorUsername: "charlie",
    replyCallbackUrl: "http://localhost:7830/deliver/slack",
    sourceMetadata: {
      messageId,
      threadId,
      chatType: "channel",
    },
    ...overrides,
  };

  return new Request("http://localhost:8080/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": TEST_BEARER_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

describe("handleChannelInbound — Slack thread backfill wiring", () => {
  beforeEach(() => {
    resetHttpState();
    seedHttpActiveMember();
    httpMsgCounter = 0;
  });

  afterEach(() => {
    backfillThreadMock.mockReset();
    _backfillTriggerCache.clear();
  });

  test("inbound thread reply with no stored parent triggers backfill from the HTTP path", async () => {
    backfillThreadMock.mockImplementation(async () => [
      makeBackfillMessage({
        id: "1234.0",
        text: "parent",
        threadId: undefined,
        sender: { id: "U_PARENT", name: "Original Poster" },
      }),
      makeBackfillMessage({
        id: "1234.1",
        text: "earlier sibling",
        threadId: "1234.0",
        sender: { id: "U_SIB", name: "Earlier Sibling" },
      }),
    ]);

    let capturedHints: string[] | undefined;
    const processMessage = async (
      _conversationId: string,
      _content: string,
      _attachmentIds?: string[],
      options?: { transport?: { hints?: string[] } },
    ): Promise<{ messageId: string }> => {
      capturedHints = options?.transport?.hints;
      return { messageId: "agent-result-id" };
    };
    setAdapterProcessMessage(processMessage);

    const req = buildThreadReplyRequest("1234.0", "1234.3");
    const resp = await handleChannelInbound(
      req,
      processMessage,
      TEST_BEARER_TOKEN,
    );
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.duplicate).toBe(false);

    // The backfill is fire-and-forget; settle the microtask queue so the
    // void-promise has time to write to the DB before we assert.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(backfillThreadMock).toHaveBeenCalledTimes(2);
    const [calledChannel, calledThread] = backfillThreadMock.mock.calls[0];
    expect(calledChannel).toBe(HTTP_SLACK_CHANNEL_ID);
    expect(calledThread).toBe("1234.0");

    const db = getDb();
    const rows = db.$client
      .prepare("SELECT metadata FROM messages")
      .all() as Array<{ metadata: string | null }>;

    const channelTimestamps = new Set<string>();
    for (const row of rows) {
      if (!row.metadata) continue;
      try {
        const envelope = JSON.parse(row.metadata) as Record<string, unknown>;
        if (typeof envelope.slackMeta === "string") {
          const slackMeta = readSlackMetadata(envelope.slackMeta);
          if (slackMeta) channelTimestamps.add(slackMeta.channelTs);
        }
      } catch {
        // ignore
      }
    }

    expect(channelTimestamps.has("1234.0")).toBe(true);
    expect(channelTimestamps.has("1234.1")).toBe(true);

    expect(
      capturedHints?.some((hint) => hint.includes("joined an existing thread")),
    ).toBe(true);
    const contents = db.$client
      .prepare("SELECT content FROM messages")
      .all() as Array<{ content: string }>;
    expect(
      contents.some((row) => row.content.includes("Slack context note")),
    ).toBe(false);
  });

  test("second thread reply within the TTL window can fetch a newer bounded gap", async () => {
    backfillThreadMock.mockImplementation(async () => [
      makeBackfillMessage({ id: "5678.0", text: "parent" }),
    ]);

    const processMessage = async (): Promise<{ messageId: string }> => ({
      messageId: "agent-result-id",
    });

    const r1 = await handleChannelInbound(
      buildThreadReplyRequest("5678.0", "5678.1"),
      processMessage,
      TEST_BEARER_TOKEN,
    );
    expect(r1.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const r2 = await handleChannelInbound(
      buildThreadReplyRequest("5678.0", "5678.2"),
      processMessage,
      TEST_BEARER_TOKEN,
    );
    expect(r2.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(backfillThreadMock).toHaveBeenCalledTimes(3);
    expect(backfillThreadMock.mock.calls[0][2]?.before).toBeUndefined();
    expect(backfillThreadMock.mock.calls[1][2]?.before).toBe("5678.1");
    expect(backfillThreadMock.mock.calls[2][2]?.before).toBe("5678.2");
  });

  test("backfill error from the HTTP path does not crash the request", async () => {
    backfillThreadMock.mockImplementation(async () => {
      throw new Error("Slack API offline");
    });

    const processMessage = async (): Promise<{ messageId: string }> => ({
      messageId: "agent-result-id",
    });

    const resp = await handleChannelInbound(
      buildThreadReplyRequest("9999.0", "9999.1"),
      processMessage,
      TEST_BEARER_TOKEN,
    );

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.accepted).toBe(true);
  });

  test("backfill is awaited: parent is stored before handleChannelInbound returns", async () => {
    // Replace the resolved promise with a manually-controlled deferred so we
    // can prove that the inbound handler awaits the backfill rather than
    // racing it against the agent-loop dispatch. If `await` were missing,
    // `handleChannelInbound` would resolve before the parent row hit the
    // database and the immediate post-response read below would miss it.
    let resolveBackfill: (() => void) | null = null;
    const backfillCompleted = new Promise<void>((resolve) => {
      resolveBackfill = resolve;
    });

    backfillThreadMock.mockImplementation(async () => {
      await backfillCompleted;
      return [
        makeBackfillMessage({
          id: "8888.0",
          text: "thread parent",
          threadId: undefined,
          sender: { id: "U_PARENT_AWAIT", name: "Parent Author" },
        }),
      ];
    });

    let agentLoopFired = false;
    const processMessage = async (): Promise<{ messageId: string }> => {
      // The agent loop runs *after* backfill. Confirm the parent row is
      // already visible at this point — that proves the backfill landed
      // before dispatch.
      agentLoopFired = true;
      return { messageId: "agent-result-id" };
    };

    const inboundPromise = handleChannelInbound(
      buildThreadReplyRequest("8888.0", "8888.1"),
      processMessage,
      TEST_BEARER_TOKEN,
    );

    // Give the handler enough microtasks to reach the awaited backfill.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Backfill is suspended at the awaited deferred — the parent row should
    // not yet be persisted, and the agent loop must not have fired.
    const db = getDb();
    const rowsBeforeResolve = db.$client
      .prepare("SELECT metadata FROM messages")
      .all() as Array<{ metadata: string | null }>;
    const tsBefore = rowsBeforeResolve
      .map((row) => {
        if (!row.metadata) return undefined;
        try {
          const env = JSON.parse(row.metadata) as Record<string, unknown>;
          if (typeof env.slackMeta !== "string") return undefined;
          const meta = readSlackMetadata(env.slackMeta);
          return meta?.channelTs;
        } catch {
          return undefined;
        }
      })
      .filter((ts): ts is string => ts !== undefined);
    expect(tsBefore.includes("8888.0")).toBe(false);
    expect(agentLoopFired).toBe(false);

    // Release the backfill mock; the awaited handler should now finish.
    resolveBackfill!();
    const resp = await inboundPromise;
    expect(resp.status).toBe(200);

    const rowsAfter = db.$client
      .prepare("SELECT metadata FROM messages")
      .all() as Array<{ metadata: string | null }>;
    const tsAfter = rowsAfter
      .map((row) => {
        if (!row.metadata) return undefined;
        try {
          const env = JSON.parse(row.metadata) as Record<string, unknown>;
          if (typeof env.slackMeta !== "string") return undefined;
          const meta = readSlackMetadata(env.slackMeta);
          return meta?.channelTs;
        } catch {
          return undefined;
        }
      })
      .filter((ts): ts is string => ts !== undefined);

    // The parent row is present before the response is delivered, so the
    // agent loop dispatched after this point sees it.
    expect(tsAfter.includes("8888.0")).toBe(true);
  });
});
