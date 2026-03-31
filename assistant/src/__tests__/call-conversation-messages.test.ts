import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  buildCallCompletionMessage,
  persistCallCompletionMessage,
} from "../calls/call-conversation-messages.js";
import {
  createCallSession,
  recordCallEvent,
  updateCallSession,
} from "../calls/call-store.js";
import { getMessages } from "../memory/conversation-crud.js";
import { getDb, initializeDb } from "../memory/db.js";
import { conversations } from "../memory/schema.js";

initializeDb();

function ensureConversation(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: `Conversation ${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM call_events");
  db.run("DELETE FROM call_pending_questions");
  db.run("DELETE FROM call_sessions");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function getLatestAssistantText(conversationId: string): string {
  const rows = getMessages(conversationId).filter(
    (m) => m.role === "assistant",
  );
  expect(rows.length).toBeGreaterThan(0);
  const latest = rows[rows.length - 1];
  const parsed = JSON.parse(latest.content) as Array<{
    type: string;
    text?: string;
  }>;
  return parsed
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

describe("call-conversation-messages", () => {
  beforeEach(() => {
    resetTables();
  });

  test("buildCallCompletionMessage labels failed calls correctly", () => {
    const conversationId = "conv-call-msg-failed";
    ensureConversation(conversationId);
    const session = createCallSession({
      conversationId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });

    updateCallSession(session.id, { status: "in_progress", startedAt: 1_000 });
    updateCallSession(session.id, { status: "failed", endedAt: 6_000 });
    recordCallEvent(session.id, "call_connected");
    recordCallEvent(session.id, "call_failed");

    expect(buildCallCompletionMessage(session.id)).toBe(
      "**Call failed** (5s). 2 event(s) recorded.",
    );
  });

  test("buildCallCompletionMessage labels cancelled calls correctly", () => {
    const conversationId = "conv-call-msg-cancelled";
    ensureConversation(conversationId);
    const session = createCallSession({
      conversationId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });

    updateCallSession(session.id, { status: "in_progress", startedAt: 1_000 });
    updateCallSession(session.id, { status: "cancelled", endedAt: 4_000 });
    recordCallEvent(session.id, "call_connected");
    recordCallEvent(session.id, "call_ended");

    expect(buildCallCompletionMessage(session.id)).toBe(
      "**Call cancelled** (3s). 2 event(s) recorded.",
    );
  });

  test("persistCallCompletionMessage keeps completed label when status is completed", async () => {
    const conversationId = "conv-call-msg-completed";
    ensureConversation(conversationId);
    const session = createCallSession({
      conversationId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });

    updateCallSession(session.id, { status: "completed" });
    recordCallEvent(session.id, "call_ended");

    const summary = await persistCallCompletionMessage(
      conversationId,
      session.id,
    );
    expect(summary).toBe("**Call completed**. 1 event(s) recorded.");
    expect(getLatestAssistantText(conversationId)).toBe(
      "**Call completed**. 1 event(s) recorded.",
    );
  });
});
