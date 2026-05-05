import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  getAttachmentById,
  getAttachmentsForMessage,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../memory/attachments-store.js";
import {
  addMessage,
  clearAll,
  createConversation,
  deleteLastExchange,
  getConversation,
  getMessages,
} from "../memory/conversation-crud.js";
import { isLastUserMessageToolResult } from "../memory/conversation-queries.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
// Initialize db once before all tests
initializeDb();

describe("deleteLastExchange", () => {
  beforeEach(() => {
    // Reset database between tests by dropping and recreating tables
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("deletes last user message and subsequent assistant messages", () => {
    const conv = createConversation("test");
    addMessage(conv.id, "user", "first question");
    addMessage(conv.id, "assistant", "first answer");
    addMessage(conv.id, "user", "second question");
    addMessage(conv.id, "assistant", "second answer");

    const deleted = deleteLastExchange(conv.id);
    expect(deleted).toBe(2);

    const remaining = getMessages(conv.id);
    expect(remaining).toHaveLength(2);
    expect(remaining[0].content).toBe("first question");
    expect(remaining[1].content).toBe("first answer");
  });

  test("returns 0 when no user messages exist", () => {
    const conv = createConversation("test");
    addMessage(conv.id, "assistant", "hello");

    const deleted = deleteLastExchange(conv.id);
    expect(deleted).toBe(0);
  });

  test("returns 0 for empty conversation", () => {
    const conv = createConversation("test");
    const deleted = deleteLastExchange(conv.id);
    expect(deleted).toBe(0);
  });

  test("uses rowid ordering so same-timestamp messages are handled correctly", () => {
    const conv = createConversation("test");
    const db = getDb();
    const now = Date.now();

    // Insert three user messages with the exact same timestamp.
    // rowid order determines which is "last", not timestamp.
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1', '${conv.id}', 'user', 'first', ${now})`,
    );
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m2', '${conv.id}', 'assistant', 'reply1', ${now})`,
    );
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m3', '${conv.id}', 'user', 'second', ${now})`,
    );
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m4', '${conv.id}', 'assistant', 'reply2', ${now})`,
    );

    // deleteLastExchange should find m3 (the last user message by rowid),
    // then delete m3 and m4 (everything at rowid >= m3's rowid).
    const deleted = deleteLastExchange(conv.id);
    expect(deleted).toBe(2);

    const remaining = getMessages(conv.id);
    expect(remaining).toHaveLength(2);
    expect(remaining[0].content).toBe("first");
    expect(remaining[1].content).toBe("reply1");
  });
});

describe("isLastUserMessageToolResult", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("returns true when last user message is tool_result only", () => {
    const conv = createConversation("test");
    addMessage(conv.id, "user", "hello");
    addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "tool_use", id: "tu1", name: "bash", input: {} },
      ]),
    );
    addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu1", content: "ok" },
      ]),
    );

    expect(isLastUserMessageToolResult(conv.id)).toBe(true);
  });

  test("returns false when last user message is plain text", () => {
    const conv = createConversation("test");
    addMessage(conv.id, "user", "hello");

    expect(isLastUserMessageToolResult(conv.id)).toBe(false);
  });

  test("returns false when no user messages exist", () => {
    const conv = createConversation("test");
    expect(isLastUserMessageToolResult(conv.id)).toBe(false);
  });

  test("returns false when last user message has mixed content types", () => {
    const conv = createConversation("test");
    addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: "hello" },
        { type: "tool_result", tool_use_id: "tu1", content: "ok" },
      ]),
    );

    expect(isLastUserMessageToolResult(conv.id)).toBe(false);
  });
});

describe("deleteLastExchange with tool_result messages", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("looping deleteLastExchange cleans up tool_result user messages", () => {
    const conv = createConversation("test");
    // Simulate: user asks question -> assistant uses tool -> tool_result -> assistant responds
    addMessage(conv.id, "user", "What files are in /tmp?");
    addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        {
          type: "tool_use",
          id: "tu1",
          name: "bash",
          input: { command: "ls /tmp" },
        },
      ]),
    );
    addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu1", content: "file1.txt" },
      ]),
    );
    addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "There is file1.txt in /tmp" }]),
    );

    // First deleteLastExchange removes the tool_result user msg + final assistant msg
    let deleted = deleteLastExchange(conv.id);
    expect(deleted).toBe(2);

    // After deleting the tool_result user + assistant, the remaining are:
    // user: "What files are in /tmp?" and assistant: tool_use
    let remaining = getMessages(conv.id);
    expect(remaining).toHaveLength(2);

    // The last user message is the real one, so isLastUserMessageToolResult should be false
    expect(isLastUserMessageToolResult(conv.id)).toBe(false);

    // Now delete again to remove the real user message + tool_use assistant
    deleted = deleteLastExchange(conv.id);
    expect(deleted).toBe(2);

    remaining = getMessages(conv.id);
    expect(remaining).toHaveLength(0);
  });

  test("looping pattern handles multiple tool uses in sequence", () => {
    const conv = createConversation("test");
    // user -> assistant(tool_use) -> user(tool_result) -> assistant(tool_use) -> user(tool_result) -> assistant(text)
    addMessage(conv.id, "user", "Do two things");
    addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "tool_use", id: "tu1", name: "bash", input: {} },
      ]),
    );
    addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu1", content: "result1" },
      ]),
    );
    addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "tool_use", id: "tu2", name: "bash", input: {} },
      ]),
    );
    addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu2", content: "result2" },
      ]),
    );
    addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Done both" }]),
    );

    // First delete: removes last tool_result user (row 5) + final assistant (row 6)
    deleteLastExchange(conv.id);
    // Last user is now row 3 (tool_result tu1)
    expect(isLastUserMessageToolResult(conv.id)).toBe(true);

    // Second delete: removes tool_result user (row 3) + assistant tool_use (row 4)
    deleteLastExchange(conv.id);
    // Last user is now row 1 (real user message)
    expect(isLastUserMessageToolResult(conv.id)).toBe(false);

    // Final delete removes the real user message + assistant tool_use
    deleteLastExchange(conv.id);

    const remaining = getMessages(conv.id);
    expect(remaining).toHaveLength(0);
  });
});

describe("attachment orphan cleanup", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM message_attachments");
    db.run("DELETE FROM attachments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  test("deleteLastExchange cleans up orphaned attachments", async () => {
    const conv = createConversation("test");
    await addMessage(conv.id, "user", "hello");
    const assistantMsg = await addMessage(
      conv.id,
      "assistant",
      "Here is a file",
    );

    const stored = uploadAttachment("chart.png", "image/png", "iVBOR");
    linkAttachmentToMessage(assistantMsg.id, stored.id, 0);

    // Verify attachment is linked
    expect(getAttachmentsForMessage(assistantMsg.id)).toHaveLength(1);

    // Delete the exchange — should also clean up orphaned attachments
    deleteLastExchange(conv.id);

    // Attachment row should be gone
    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;
    const remaining = raw
      .query("SELECT COUNT(*) AS c FROM attachments")
      .get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  test("deleteLastExchange preserves attachments still linked to other messages", async () => {
    const conv = createConversation("test");
    const msg1 = await addMessage(conv.id, "assistant", "first");
    await addMessage(conv.id, "user", "question");
    const msg2 = await addMessage(conv.id, "assistant", "second");

    const shared = uploadAttachment("shared.png", "image/png", "AAAA");
    linkAttachmentToMessage(msg1.id, shared.id, 0);
    linkAttachmentToMessage(msg2.id, shared.id, 0);

    // Delete last exchange (removes msg2 + user question)
    deleteLastExchange(conv.id);

    // Attachment should survive because msg1 still links to it
    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;
    const remaining = raw
      .query("SELECT COUNT(*) AS c FROM attachments")
      .get() as { c: number };
    expect(remaining.c).toBe(1);
  });

  test("clearAll removes all attachments", async () => {
    const conv = createConversation("test");
    const msg = await addMessage(conv.id, "assistant", "file");
    const stored = uploadAttachment("doc.pdf", "application/pdf", "JVBER");
    linkAttachmentToMessage(msg.id, stored.id, 0);

    clearAll();

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;
    const attachmentCount = raw
      .query("SELECT COUNT(*) AS c FROM attachments")
      .get() as { c: number };
    const linkCount = raw
      .query("SELECT COUNT(*) AS c FROM message_attachments")
      .get() as { c: number };
    expect(attachmentCount.c).toBe(0);
    expect(linkCount.c).toBe(0);
  });

  test("deleteLastExchange does not delete unlinked user uploads", async () => {
    const conv = createConversation("test");
    await addMessage(conv.id, "user", "hello");
    const assistantMsg = await addMessage(
      conv.id,
      "assistant",
      "Here is a file",
    );

    // An attachment linked to the assistant message (should be cleaned up)
    const linked = uploadAttachment("chart.png", "image/png", "iVBOR");
    linkAttachmentToMessage(assistantMsg.id, linked.id, 0);

    // A freshly uploaded attachment not linked to any message (should survive)
    uploadAttachment("pending.png", "image/png", "AAAA");

    deleteLastExchange(conv.id);

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;
    const remaining = raw
      .query("SELECT COUNT(*) AS c FROM attachments")
      .get() as { c: number };
    expect(remaining.c).toBe(1); // only the unlinked upload survives
  });
});

describe("conversation metadata defaults", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("new conversation has conversationType defaulting to standard", () => {
    const conv = createConversation("test");
    expect(conv.conversationType).toBe("standard");
  });

  test("new conversation has memoryScopeId defaulting to default", () => {
    const conv = createConversation("test");
    expect(conv.memoryScopeId).toBe("default");
  });

  test("defaults are persisted and retrievable from DB", () => {
    const conv = createConversation("test");
    const loaded = getConversation(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.conversationType).toBe("standard");
    expect(loaded!.memoryScopeId).toBe("default");
  });

  test("existing conversations without explicit values get defaults via migration", () => {
    // Insert a conversation row directly without the new columns
    // (simulates a pre-migration row — the ALTER TABLE DEFAULT handles it)
    const db = getDb();
    const now = Date.now();
    const id = "legacy-conv-" + now;
    db.run(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('${id}', 'legacy', ${now}, ${now})`,
    );

    const loaded = getConversation(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.conversationType).toBe("standard");
    expect(loaded!.memoryScopeId).toBe("default");
  });
});

describe("createConversation with conversation type option", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("standard create with string title uses defaults", () => {
    const conv = createConversation("hello");
    expect(conv.title).toBe("hello");
    expect(conv.conversationType).toBe("standard");
    expect(conv.memoryScopeId).toBe("default");
  });

  test("standard create with options object uses defaults", () => {
    const conv = createConversation({
      title: "hello",
      conversationType: "standard",
    });
    expect(conv.conversationType).toBe("standard");
    expect(conv.memoryScopeId).toBe("default");
  });

  test("no-arg create uses defaults", () => {
    const conv = createConversation();
    expect(conv.conversationType).toBe("standard");
    expect(conv.memoryScopeId).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Baseline: attachment reuse across conversations
// ---------------------------------------------------------------------------

describe("attachment reuse across conversation lifecycles", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM message_attachments");
    db.run("DELETE FROM attachments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  test("attachment uploaded in conversation A is retrievable by ID without any conversation reference", async () => {
    const convA = createConversation("Conversation A");
    const msgA = await addMessage(convA.id, "assistant", "Here is a file");
    const stored = uploadAttachment(
      "report.pdf",
      "application/pdf",
      "JVBERA==",
    );
    linkAttachmentToMessage(msgA.id, stored.id, 0);

    // Create a completely separate conversation
    const convB = createConversation("Conversation B");
    await addMessage(convB.id, "user", "hello");

    // The attachment is retrievable by ID regardless of which conversation is active.
    const fetched = getAttachmentById(stored.id, { hydrateFileData: true });
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(stored.id);
    expect(fetched!.originalFilename).toBe("report.pdf");
    expect(fetched!.dataBase64).toBe("JVBERA==");
  });

  test("re-linking an attachment across conversations creates a conversation-local row", async () => {
    const convA = createConversation("Conversation A");
    const convB = createConversation("Conversation B");

    const msgA = await addMessage(convA.id, "assistant", "Original file");
    const msgB = await addMessage(convB.id, "assistant", "Reused file");

    // Upload once, link to both conversations
    const stored = uploadAttachment("shared.png", "image/png", "iVBORw0K");
    linkAttachmentToMessage(msgA.id, stored.id, 0);
    linkAttachmentToMessage(msgB.id, stored.id, 0);

    // Both messages see the attachment, but each conversation keeps its own row.
    const linkedA = getAttachmentsForMessage(msgA.id);
    expect(linkedA).toHaveLength(1);
    expect(linkedA[0].id).toBe(stored.id);

    const linkedB = getAttachmentsForMessage(msgB.id);
    expect(linkedB).toHaveLength(1);
    expect(linkedB[0].id).not.toBe(stored.id);
  });

  test("deleting conversation A does not remove the copied attachment in conversation B", async () => {
    const convA = createConversation("Conversation A");
    const convB = createConversation("Conversation B");

    // deleteLastExchange deletes from the last user message onward,
    // so we need a user message before the assistant message that carries the attachment.
    await addMessage(convA.id, "user", "Please generate a chart");
    const msgA = await addMessage(convA.id, "assistant", "Original");
    await addMessage(convB.id, "user", "Show me the chart");
    const msgB = await addMessage(convB.id, "assistant", "Reused");

    const stored = uploadAttachment("chart.png", "image/png", "AAAA");
    linkAttachmentToMessage(msgA.id, stored.id, 0);
    linkAttachmentToMessage(msgB.id, stored.id, 0);
    const linkedB = getAttachmentsForMessage(msgB.id);
    expect(linkedB).toHaveLength(1);

    // Delete conversation A's exchange
    deleteLastExchange(convA.id);

    // Conversation B keeps its own attachment row and file.
    const fetched = getAttachmentById(linkedB[0].id);
    expect(fetched).not.toBeNull();

    // convB's message still has the attachment linked
    const linkedBAfterDelete = getAttachmentsForMessage(msgB.id);
    expect(linkedBAfterDelete).toHaveLength(1);
    expect(linkedBAfterDelete[0].id).toBe(linkedB[0].id);
  });

  test("identical uploads remain distinct across conversations", async () => {
    const convA = createConversation("Conversation A");
    const convB = createConversation("Conversation B");

    await addMessage(convA.id, "user", "upload in A");
    await addMessage(convB.id, "user", "upload in B");

    const first = uploadAttachment("photo.png", "image/png", "DEDUPCROSS");
    const second = uploadAttachment("photo.png", "image/png", "DEDUPCROSS");

    expect(second.id).not.toBe(first.id);
  });
});
