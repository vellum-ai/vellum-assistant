import { beforeEach, describe, expect, test } from "bun:test";

import {
  buildCallCompletionMessage,
  persistCallCompletionMessage,
} from "../calls/call-conversation-messages.js";
import {
  createCallSession,
  recordCallEvent,
  updateCallSession,
} from "../calls/call-store.js";
import { addMessage, getMessages } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations } from "../persistence/schema/index.js";
import { contentBlockArraySchema } from "../providers/content-block-schema.js";

await initializeDb();

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

type PersistedBlock = {
  type: string;
  text?: string;
  surfaceType?: string;
  surfaceId?: string;
  data?: { summaryText?: string };
  _surfaceFallback?: boolean;
};

/**
 * The blocks of the latest assistant message carrying a `call_summary` card.
 *
 * Selecting on the card rather than on "latest assistant row" keeps these
 * assertions independent of rows other test files leave in the shared
 * workspace DB when the suite runs as one process.
 */
function getLatestAssistantBlocks(conversationId: string): PersistedBlock[] {
  const rows = getMessages(conversationId).filter((m) => {
    if (m.role !== "assistant") {
      return false;
    }
    const blocks = m.content as unknown as PersistedBlock[];
    return (
      Array.isArray(blocks) &&
      blocks.some(
        (b) => b.type === "ui_surface" && b.surfaceType === "call_summary",
      )
    );
  });
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1].content as unknown as PersistedBlock[];
}

/**
 * The message's model-visible copy. A call summary persists as a
 * `[ui_surface, text]` pair carrying the SAME sentence, so text blocks win and
 * the card is read only for legacy rows that predate the fallback sibling —
 * concatenating both would double the summary.
 */
function getLatestAssistantText(conversationId: string): string {
  const parsed = getLatestAssistantBlocks(conversationId);
  const text = parsed
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  if (text) {
    return text;
  }
  return parsed
    .filter((b) => b.type === "ui_surface" && b.surfaceType === "call_summary")
    .map((b) => b.data?.summaryText ?? "")
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

  test("persistCallCompletionMessage pairs the card with a flagged text fallback", async () => {
    // Every provider drops `ui_surface` when serializing history, so the card
    // alone left the model unable to tell that a call happened — the turn
    // reached the wire as a "blocks omitted" sentinel (LUM-2869). The
    // `_surfaceFallback` sibling is what carries the summary to the model,
    // search indexing, CLI display, and channel replies; its flag keeps
    // surface-capable clients from rendering the card AND a duplicate line.
    const conversationId = "conv-call-msg-fallback";
    ensureConversation(conversationId);
    const session = createCallSession({
      conversationId,
      provider: "twilio",
      fromNumber: "+12025550101",
      toNumber: "+12025550102",
    });

    updateCallSession(session.id, { status: "in_progress", startedAt: 1_000 });
    updateCallSession(session.id, { status: "completed", endedAt: 43_000 });
    recordCallEvent(session.id, "call_ended");

    const summary = await persistCallCompletionMessage(
      conversationId,
      session.id,
    );
    const blocks = getLatestAssistantBlocks(conversationId);

    expect(blocks).toHaveLength(2);
    const [surface, fallback] = blocks;

    expect(surface!.type).toBe("ui_surface");
    expect(surface!.surfaceType).toBe("call_summary");
    expect(surface!.surfaceId).toBeTruthy();
    expect(surface!.data?.summaryText).toBe(summary);

    expect(fallback!.type).toBe("text");
    expect(fallback!._surfaceFallback).toBe(true);
    expect(fallback!.text).toBe(summary);
    expect(fallback!.text).toContain("(42s)");
  });

  test("persisted call-summary blocks satisfy the ContentBlock schema", async () => {
    // The pair is JSON-serialized straight into `messages.content`. If it did
    // not validate, every read of the row would pay the per-block repair —
    // the read-path noise that spiked with voice GA (LUM-2869).
    const conversationId = "conv-call-msg-schema";
    ensureConversation(conversationId);
    const session = createCallSession({
      conversationId,
      provider: "twilio",
      fromNumber: "+12025550101",
      toNumber: "+12025550102",
    });
    updateCallSession(session.id, { status: "completed" });
    recordCallEvent(session.id, "call_ended");
    await persistCallCompletionMessage(conversationId, session.id);

    const blocks = getLatestAssistantBlocks(conversationId);
    expect(contentBlockArraySchema.safeParse(blocks).success).toBe(true);
  });

  test("persisting a card-only message throws in tests (model-invisible guard)", async () => {
    // The guard in `insertMessageCore` is what stops LUM-2869 recurring: a
    // producer that persists a card with no model-readable sibling fails its
    // own suite instead of silently shipping turns the model cannot see.
    // (In production the same condition only warns — never-block posture.)
    const conversationId = "conv-card-only-guard";
    ensureConversation(conversationId);
    await expect(
      addMessage(
        conversationId,
        "assistant",
        JSON.stringify([
          {
            type: "ui_surface",
            surfaceId: "bare-1",
            surfaceType: "call_summary",
            data: { summaryText: "orphaned card" },
          },
        ]),
      ),
    ).rejects.toThrow(/only content is ui_surface/);
  });
});
