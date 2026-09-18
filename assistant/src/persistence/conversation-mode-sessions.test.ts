import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  advanceConversationModeSessionRevision,
  beginConversationModeSession,
  finalizeConversationModeSession,
  getConversationModeSession,
  listConversationModeSessionsByIds,
  repairConversationModeSessionBoundaries,
  updateConversationModeSessionActivity,
  updateConversationModeSessionBoundaries,
} from "./conversation-mode-sessions.js";
import { migrateCreateConversationModeSessions } from "./migrations/381-create-conversation-mode-sessions.js";
import * as schema from "./schema.js";

function createStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/* sql */ `
    PRAGMA foreign_keys = ON;
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'assistant',
      created_at INTEGER NOT NULL,
      metadata TEXT
    );
    INSERT INTO conversations (id) VALUES ('conv-123'), ('conv-456');
  `);
  const db = drizzle(sqlite, { schema });
  migrateCreateConversationModeSessions(db);
  return { sqlite, db, options: { db } };
}

describe("conversation mode session store", () => {
  test("records activity and display boundaries with monotonic revisions", () => {
    const { options } = createStore();
    const started = beginConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        mode: "computer_use",
        sourceStartedAt: 100,
      },
      options,
    );
    expect(started).toMatchObject({
      ok: true,
      session: {
        revision: 1,
        status: "active",
        lastActivityAt: 100,
      },
    });

    const activity = updateConversationModeSessionActivity(
      {
        id: "session-123",
        conversationId: "conv-123",
        expectedRevision: 1,
        lastActivityAt: 150,
        lastOwnedMessageId: "message-456",
      },
      options,
    );
    expect(activity).toMatchObject({
      ok: true,
      session: {
        revision: 2,
        lastActivityAt: 150,
        lastOwnedMessageId: "message-456",
      },
    });

    const boundaries = updateConversationModeSessionBoundaries(
      {
        id: "session-123",
        conversationId: "conv-123",
        expectedRevision: 2,
        firstIncluded: { at: 90, messageId: "message-123" },
        lastActivityAt: 175,
        lastOwnedMessageId: "message-789",
      },
      options,
    );
    expect(boundaries).toMatchObject({
      ok: true,
      session: {
        revision: 3,
        firstIncludedAt: 90,
        firstIncludedMessageId: "message-123",
        lastActivityAt: 175,
        lastOwnedMessageId: "message-789",
      },
    });

    expect(
      updateConversationModeSessionActivity(
        {
          id: "session-123",
          conversationId: "conv-123",
          expectedRevision: 3,
          lastActivityAt: 125,
        },
        options,
      ),
    ).toMatchObject({
      ok: true,
      session: { revision: 4, lastActivityAt: 175 },
    });
  });

  test("rejects stale writes and keeps terminal records immutable", () => {
    const { options } = createStore();
    beginConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        mode: "browser",
        sourceStartedAt: 100,
      },
      options,
    );
    const advanced = advanceConversationModeSessionRevision(
      {
        id: "session-123",
        conversationId: "conv-123",
        expectedRevision: 1,
      },
      options,
    );
    expect(advanced).toMatchObject({ ok: true, session: { revision: 2 } });

    expect(
      finalizeConversationModeSession(
        {
          id: "session-123",
          conversationId: "conv-123",
          expectedRevision: 1,
          status: "completed",
          endedAt: 180,
          endReason: "settled",
        },
        options,
      ),
    ).toMatchObject({
      ok: false,
      reason: "stale_revision",
      session: { revision: 2, status: "active" },
    });

    const finalized = finalizeConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        expectedRevision: 2,
        status: "completed",
        endedAt: 180,
        endReason: "settled",
      },
      options,
    );
    expect(finalized).toMatchObject({
      ok: true,
      session: { revision: 3, status: "completed", endedAt: 180 },
    });

    expect(
      finalizeConversationModeSession(
        {
          id: "session-123",
          conversationId: "conv-123",
          expectedRevision: 2,
          status: "completed",
          endedAt: 180,
          endReason: "settled",
        },
        options,
      ),
    ).toMatchObject({
      ok: true,
      session: { revision: 3, status: "completed", endedAt: 180 },
    });

    expect(
      finalizeConversationModeSession(
        {
          id: "session-123",
          conversationId: "conv-123",
          expectedRevision: 2,
          status: "interrupted",
          endedAt: null,
          endReason: "late_callback",
        },
        options,
      ),
    ).toMatchObject({
      ok: false,
      reason: "terminal",
      session: { revision: 3, status: "completed", endedAt: 180 },
    });
  });

  test("rejects a terminal timestamp before confirmed activity", () => {
    const { options } = createStore();
    beginConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        mode: "browser",
        sourceStartedAt: 100,
      },
      options,
    );

    expect(() =>
      finalizeConversationModeSession(
        {
          id: "session-123",
          conversationId: "conv-123",
          expectedRevision: 1,
          status: "completed",
          endedAt: 90,
          endReason: "settled",
        },
        options,
      ),
    ).toThrow("Mode session end cannot precede its last activity");
    expect(
      getConversationModeSession("conv-123", "session-123", options),
    ).toMatchObject({ status: "active", revision: 1 });
  });

  test("does not reopen an existing id and scopes batched reads by conversation", () => {
    const { options } = createStore();
    beginConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        mode: "browser",
        sourceStartedAt: 100,
      },
      options,
    );
    beginConversationModeSession(
      {
        id: "session-456",
        conversationId: "conv-456",
        mode: "ambient",
        sourceStartedAt: 200,
      },
      options,
    );

    expect(
      beginConversationModeSession(
        {
          id: "session-123",
          conversationId: "conv-123",
          mode: "computer_use",
          sourceStartedAt: 300,
        },
        options,
      ),
    ).toMatchObject({
      ok: false,
      reason: "already_exists",
      session: { mode: "browser", sourceStartedAt: 100, revision: 1 },
    });

    expect(
      listConversationModeSessionsByIds(
        "conv-123",
        ["session-456", "session-123", "session-123"],
        options,
      ).map((session) => session.id),
    ).toEqual(["session-123"]);
    expect(getConversationModeSession("conv-123", "session-456", options)).toBe(
      null,
    );
  });

  test("repairs replaceable boundaries without reopening a terminal session", () => {
    const { sqlite, options } = createStore();
    beginConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        mode: "browser",
        sourceStartedAt: 100,
      },
      options,
    );
    updateConversationModeSessionBoundaries(
      {
        id: "session-123",
        conversationId: "conv-123",
        expectedRevision: 1,
        firstIncluded: { at: 90, messageId: "message-deleted" },
        lastActivityAt: 100,
        lastOwnedMessageId: "message-last",
      },
      options,
    );
    finalizeConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        expectedRevision: 2,
        status: "completed",
        endedAt: 150,
        endReason: "settled",
      },
      options,
    );
    sqlite.exec(/* sql */ `
      INSERT INTO messages (id, conversation_id, created_at, metadata)
      VALUES
        ('message-leading', 'conv-123', 110, '{"modeSession":{"mode":"browser","id":"session-123"}}'),
        ('message-middle', 'conv-123', 120, '{"modeSession":{"mode":"browser","id":"session-123"},"sentAt":115}'),
        ('message-last', 'conv-123', 130, '{"modeSession":{"mode":"browser","id":"session-123"}}'),
        ('message-other', 'conv-456', 90, '{"modeSession":{"mode":"browser","id":"session-123"}}');
    `);
    sqlite.exec(
      "UPDATE messages SET role = 'user' WHERE id = 'message-leading'",
    );

    expect(repairConversationModeSessionBoundaries("conv-123", options)).toBe(
      1,
    );
    expect(
      getConversationModeSession("conv-123", "session-123", options),
    ).toMatchObject({
      status: "completed",
      endedAt: 150,
      endReason: "settled",
      revision: 4,
      firstIncludedAt: 115,
      firstIncludedMessageId: "message-middle",
      lastOwnedMessageId: "message-last",
      lastActivityAt: 130,
    });
  });

  test("repairs Ambient to an assistant-first boundary while Live keeps its leading frame", () => {
    const { sqlite, options } = createStore();
    beginConversationModeSession(
      {
        id: "ambient-session",
        conversationId: "conv-123",
        mode: "ambient",
        sourceStartedAt: 100,
      },
      options,
    );
    beginConversationModeSession(
      {
        id: "live-session",
        conversationId: "conv-123",
        mode: "live_vision",
        sourceStartedAt: 200,
      },
      options,
    );
    sqlite.exec(/* sql */ `
      INSERT INTO messages (id, conversation_id, role, created_at, metadata)
      VALUES
        ('ambient-deleted', 'conv-123', 'user', 105, '{"modeSession":{"mode":"ambient","id":"ambient-session"}}'),
        ('ambient-frame', 'conv-123', 'user', 110, '{"modeSession":{"mode":"ambient","id":"ambient-session"}}'),
        ('ambient-assistant', 'conv-123', 'assistant', 120, '{"modeSession":{"mode":"ambient","id":"ambient-session"}}'),
        ('live-deleted', 'conv-123', 'user', 205, '{"modeSession":{"mode":"live_vision","id":"live-session"}}'),
        ('live-frame', 'conv-123', 'user', 210, '{"modeSession":{"mode":"live_vision","id":"live-session"}}'),
        ('live-assistant', 'conv-123', 'assistant', 220, '{"modeSession":{"mode":"live_vision","id":"live-session"}}');
    `);
    updateConversationModeSessionBoundaries(
      {
        id: "ambient-session",
        conversationId: "conv-123",
        expectedRevision: 1,
        firstIncluded: { at: 105, messageId: "ambient-deleted" },
        lastActivityAt: 120,
        lastOwnedMessageId: "ambient-assistant",
      },
      options,
    );
    updateConversationModeSessionBoundaries(
      {
        id: "live-session",
        conversationId: "conv-123",
        expectedRevision: 1,
        firstIncluded: { at: 205, messageId: "live-deleted" },
        lastActivityAt: 220,
        lastOwnedMessageId: "live-assistant",
      },
      options,
    );
    sqlite.exec(
      "DELETE FROM messages WHERE id IN ('ambient-deleted', 'live-deleted')",
    );

    expect(repairConversationModeSessionBoundaries("conv-123", options)).toBe(
      2,
    );
    expect(
      getConversationModeSession("conv-123", "ambient-session", options),
    ).toMatchObject({
      firstIncludedAt: 120,
      firstIncludedMessageId: "ambient-assistant",
      lastOwnedMessageId: "ambient-assistant",
      lastActivityAt: 120,
    });
    expect(
      getConversationModeSession("conv-123", "live-session", options),
    ).toMatchObject({
      firstIncludedAt: 210,
      firstIncludedMessageId: "live-frame",
      lastOwnedMessageId: "live-assistant",
      lastActivityAt: 220,
    });
  });
});
