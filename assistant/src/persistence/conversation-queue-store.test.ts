import { beforeEach, describe, expect, test } from "bun:test";

import { createConversation } from "./conversation-crud.js";
import {
  deleteRow,
  deleteRowsForConversation,
  insertQueuedRow,
  listConversationIdsWithRows,
  loadRows,
  markDraining,
  markQueued,
  promoteRowToHead,
} from "./conversation-queue-store.js";
import { getDb } from "./db-connection.js";
import { initializeDb } from "./db-init.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM conversation_queued_messages");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function seedConversation(): string {
  return createConversation("Queue store test").id;
}

function makeMessage(requestId: string, content = "queued text") {
  return { requestId, content, sentAt: 1_000 };
}

describe("conversation-queue-store", () => {
  beforeEach(() => {
    resetTables();
  });

  test("inserts assign ascending FIFO sort keys per conversation", () => {
    const convA = seedConversation();
    const convB = seedConversation();
    insertQueuedRow(convA, makeMessage("a-1"));
    insertQueuedRow(convB, makeMessage("b-1"));
    insertQueuedRow(convA, makeMessage("a-2"));

    const backlogA = loadRows(convA);
    expect(backlogA.map((row) => row.requestId)).toEqual(["a-1", "a-2"]);
    expect(backlogA[0]!.sortKey).toBeLessThan(backlogA[1]!.sortKey);
    expect(loadRows(convB).map((row) => row.requestId)).toEqual(["b-1"]);
  });

  test("round-trips the persistable projection through JSON columns", () => {
    const conv = seedConversation();
    insertQueuedRow(conv, {
      requestId: "req-1",
      content: "agent-facing text",
      displayContent: "what the user typed",
      clientMessageId: "nonce-1",
      attachments: [{ filename: "a.txt", mimeType: "text/plain" }],
      metadata: { hidden: true, nested: { keep: 1 } },
      transport: { clientOs: "macos" },
      sourceActorPrincipalId: "actor-1",
      isInteractive: false,
      sentAt: 42,
    });

    const [row] = loadRows(conv);
    expect(row).toMatchObject({
      requestId: "req-1",
      content: "agent-facing text",
      displayContent: "what the user typed",
      clientMessageId: "nonce-1",
      attachments: [{ filename: "a.txt", mimeType: "text/plain" }],
      metadata: { hidden: true, nested: { keep: 1 } },
      transport: { clientOs: "macos" },
      sourceActorPrincipalId: "actor-1",
      isInteractive: false,
      sentAt: 42,
      state: "queued",
    });
  });

  test("promote moves one row to the head without renumbering siblings", () => {
    const conv = seedConversation();
    insertQueuedRow(conv, makeMessage("first"));
    insertQueuedRow(conv, makeMessage("second"));
    insertQueuedRow(conv, makeMessage("third"));

    promoteRowToHead(conv, "third");

    expect(loadRows(conv).map((row) => row.requestId)).toEqual([
      "third",
      "first",
      "second",
    ]);
  });

  test("draining rows survive and read back for recovery; markQueued restores them", () => {
    const conv = seedConversation();
    insertQueuedRow(conv, makeMessage("req-1"));
    markDraining("req-1");

    const [draining] = loadRows(conv);
    expect(draining!.state).toBe("draining");

    markQueued("req-1");
    expect(loadRows(conv)[0]!.state).toBe("queued");
  });

  test("deleteRow and deleteRowsForConversation remove exactly their targets", () => {
    const convA = seedConversation();
    const convB = seedConversation();
    insertQueuedRow(convA, makeMessage("a-1"));
    insertQueuedRow(convA, makeMessage("a-2"));
    insertQueuedRow(convB, makeMessage("b-1"));

    deleteRow("a-1");
    expect(loadRows(convA).map((row) => row.requestId)).toEqual(["a-2"]);

    deleteRowsForConversation(convA);
    expect(loadRows(convA)).toEqual([]);
    expect(loadRows(convB)).toHaveLength(1);
  });

  test("listConversationIdsWithRows names each backlogged conversation once", () => {
    const convA = seedConversation();
    const convB = seedConversation();
    seedConversation();
    insertQueuedRow(convA, makeMessage("a-1"));
    insertQueuedRow(convA, makeMessage("a-2"));
    insertQueuedRow(convB, makeMessage("b-1"));

    expect(listConversationIdsWithRows().sort()).toEqual([convA, convB].sort());
  });

  test("a failed write degrades silently instead of throwing", () => {
    // FK violation: the conversation does not exist, so the insert fails
    // inside the store. The helper must swallow it (the queue accepted the
    // message; a storage failure must not reject the send) and reads must
    // answer with an empty backlog.
    expect(() =>
      insertQueuedRow("missing-conversation", makeMessage("req-1")),
    ).not.toThrow();
    expect(loadRows("missing-conversation")).toEqual([]);
  });
});
