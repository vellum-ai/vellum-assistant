/**
 * Tests for `discardLastAssistantDisplayTurn` and `extractUserPromptText` —
 * the retry endpoint's truncation primitives. DB-backed: exercises the real
 * message CRUD (deleteMessageById cascade, metadata merge) against the test
 * database rather than mocking persistence.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  discardLastAssistantDisplayTurn,
  extractUserPromptText,
} from "../daemon/conversation-history.js";
import { registerPluginHooks } from "../hooks/registry.js";
import { addMessage, getMessages } from "../persistence/conversation-crud.js";
import { getDb, getMemorySqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations, messages } from "../persistence/schema/index.js";
import memoryMessageDeleted from "../plugins/defaults/memory/hooks/message-deleted.js";
import {
  ensureRetrospectiveCursorColumn,
  getRetrospectiveState,
} from "../plugins/defaults/memory/memory-retrospective-state.js";
import type { PluginHooks } from "../plugins/types.js";

await initializeDb();

// Register the memory plugin's `message-deleted` hook the way boot does, so
// the delete primitive's dispatch reaches the cursor bookkeeping.
registerPluginHooks("default-memory", {
  "message-deleted": memoryMessageDeleted,
} as PluginHooks);

const CONV_ID = "conv-retry-discard-test";

function seedConversation(): void {
  const now = Date.now();
  getDb()
    .insert(conversations)
    .values({
      id: CONV_ID,
      title: "Retry discard test",
      createdAt: now,
      updatedAt: now,
      source: "test",
      conversationType: "standard",
    })
    .run();
}

function clearAll(): void {
  getDb().delete(messages).run();
  getDb().delete(conversations).run();
}

const text = (t: string) => JSON.stringify([{ type: "text", text: t }]);
const toolUse = (t: string) =>
  JSON.stringify([
    { type: "text", text: t },
    { type: "tool_use", id: "tool-1", name: "web_search", input: {} },
  ]);
const toolResultOnly = () =>
  JSON.stringify([
    { type: "tool_result", tool_use_id: "tool-1", content: "result" },
  ]);

async function seed(
  rows: Array<{
    role: "user" | "assistant";
    content: string;
    metadata?: Record<string, unknown>;
  }>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const row of rows) {
    const inserted = await addMessage(CONV_ID, row.role, row.content, {
      metadata: row.metadata,
    });
    ids.push(inserted.id);
  }
  return ids;
}

beforeEach(() => {
  clearAll();
  seedConversation();
});

describe("discardLastAssistantDisplayTurn", () => {
  test("deletes the assistant reply, keeps the user anchor", async () => {
    const [userId, assistantId] = await seed([
      { role: "user", content: text("hello") },
      { role: "assistant", content: text("Processing failed: boom") },
    ]);

    const result = discardLastAssistantDisplayTurn(CONV_ID);

    expect(result).not.toBeNull();
    expect(result!.anchor.id).toBe(userId);
    expect(result!.deletedMessageIds).toEqual([assistantId]);
    expect(getMessages(CONV_ID).map((m) => m.id)).toEqual([userId]);
  });

  test("deletes a multi-row display turn (assistant, tool_result, assistant)", async () => {
    const [userId, a1, tr, a2] = await seed([
      { role: "user", content: text("look this up") },
      { role: "assistant", content: toolUse("searching…") },
      { role: "user", content: toolResultOnly() },
      { role: "assistant", content: text("found it") },
    ]);

    const result = discardLastAssistantDisplayTurn(CONV_ID);

    expect(result!.anchor.id).toBe(userId);
    // Newest-first: an interrupted run leaves a well-formed shorter tail.
    expect(result!.deletedMessageIds).toEqual([a2, tr, a1]);
    expect(getMessages(CONV_ID).map((m) => m.id)).toEqual([userId]);
  });

  test("never anchors on a tool-result-only user row", async () => {
    const [userId, a1, tr] = await seed([
      { role: "user", content: text("run the tool") },
      { role: "assistant", content: toolUse("running…") },
      { role: "user", content: toolResultOnly() },
    ]);

    const result = discardLastAssistantDisplayTurn(CONV_ID);

    expect(result!.anchor.id).toBe(userId);
    expect(result!.deletedMessageIds).toEqual([tr, a1]);
  });

  test("a hidden machine-signal user row is a valid anchor", async () => {
    const [, , wakeId, replyId] = await seed([
      { role: "user", content: text("earlier prompt") },
      { role: "assistant", content: text("earlier reply") },
      {
        role: "user",
        content: text(
          '<background_event source="schedule">tick</background_event>',
        ),
        metadata: { backgroundEventSource: "schedule" },
      },
      { role: "assistant", content: text("Processing failed: boom") },
    ]);

    const result = discardLastAssistantDisplayTurn(CONV_ID);

    expect(result!.anchor.id).toBe(wakeId);
    expect(result!.deletedMessageIds).toEqual([replyId]);
    expect(getMessages(CONV_ID)).toHaveLength(3);
  });

  test("earlier turns are untouched", async () => {
    const [u1, a1, u2, a2] = await seed([
      { role: "user", content: text("first question") },
      { role: "assistant", content: text("first answer") },
      { role: "user", content: text("second question") },
      { role: "assistant", content: text("second answer") },
    ]);

    const result = discardLastAssistantDisplayTurn(CONV_ID);

    expect(result!.anchor.id).toBe(u2);
    expect(result!.deletedMessageIds).toEqual([a2]);
    expect(getMessages(CONV_ID).map((m) => m.id)).toEqual([u1, a1, u2]);
  });

  test("no turn-starting user row → null, nothing deleted", async () => {
    const [assistantId] = await seed([
      { role: "assistant", content: text("orphan assistant row") },
    ]);

    expect(discardLastAssistantDisplayTurn(CONV_ID)).toBeNull();
    expect(getMessages(CONV_ID).map((m) => m.id)).toEqual([assistantId]);
  });

  test("empty tail → anchor returned with no deletions", async () => {
    const [userId] = await seed([
      { role: "user", content: text("no reply yet") },
    ]);

    const result = discardLastAssistantDisplayTurn(CONV_ID);

    expect(result!.anchor.id).toBe(userId);
    expect(result!.deletedMessageIds).toEqual([]);
    expect(getMessages(CONV_ID).map((m) => m.id)).toEqual([userId]);
  });

  test("clears the anchor's turnOutcome failure stamp", async () => {
    const [userId] = await seed([
      {
        role: "user",
        content: text("doomed prompt"),
        metadata: { turnOutcome: "failed", turnFailureCode: "PROVIDER_ERROR" },
      },
      { role: "assistant", content: text("Processing failed: boom") },
    ]);

    discardLastAssistantDisplayTurn(CONV_ID);

    const anchor = getMessages(CONV_ID).find((m) => m.id === userId)!;
    const metadata = JSON.parse(anchor.metadata!) as Record<string, unknown>;
    expect(metadata.turnOutcome).toBeNull();
    expect(metadata.turnFailureCode).toBeNull();
  });
});

describe("extractUserPromptText", () => {
  test("joins text blocks and skips system_notice and non-text blocks", () => {
    expect(
      extractUserPromptText([
        { type: "text", text: "line one" },
        {
          type: "text",
          text: "<system_notice>internal nudge</system_notice>",
        },
        { type: "tool_result", tool_use_id: "t1", content: "ignored" },
        { type: "text", text: "line two" },
      ] as never),
    ).toBe("line one\nline two");
  });

  test("empty content → empty string", () => {
    expect(extractUserPromptText([])).toBe("");
  });
});

describe("discardLastAssistantDisplayTurn keeps the memory-retrospective cursor placeable", () => {
  beforeEach(() => {
    ensureRetrospectiveCursorColumn("test");
    getMemorySqlite()!.exec(`DELETE FROM memory_retrospective_state`);
  });

  test("a cursor stored without its timestamp gets it from the reply being discarded", async () => {
    const [, assistantId] = await seed([
      { role: "user", content: text("hello") },
      { role: "assistant", content: text("first attempt") },
    ]);
    const replyCreatedAt = getMessages(CONV_ID).find(
      (m) => m.id === assistantId,
    )!.createdAt;
    // A state row as a build without the timestamp column wrote it: the
    // retrospective reviewed through the reply, so the cursor sits on it.
    getMemorySqlite()!
      .query(
        `INSERT INTO memory_retrospective_state
           (conversation_id, last_processed_message_id, last_run_at, remembered_log, last_processed_created_at)
         VALUES (?, ?, 1, NULL, NULL)`,
      )
      .run(CONV_ID, assistantId);

    discardLastAssistantDisplayTurn(CONV_ID);

    expect(getMessages(CONV_ID).some((m) => m.id === assistantId)).toBe(false);
    // The hook chain is fire-and-forget from the delete primitive, so the
    // stamp lands shortly after the discard returns.
    const deadline = Date.now() + 2_000;
    let stamped =
      getRetrospectiveState(CONV_ID)?.lastProcessedCreatedAt ?? null;
    while (stamped === null && Date.now() < deadline) {
      await Bun.sleep(10);
      stamped = getRetrospectiveState(CONV_ID)?.lastProcessedCreatedAt ?? null;
    }
    expect(stamped).toBe(replyCreatedAt);
  });
});
