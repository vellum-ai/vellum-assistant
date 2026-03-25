/**
 * Tests for handleListMessages attachment handling.
 *
 * Verifies that:
 * - User message image attachments include base64 data for client thumbnail generation
 * - User message non-image attachments stay metadata-only (no base64 blob)
 * - Assistant message image attachments include base64 data (same as user messages)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "list-messages-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
  getRootDir: () => testDir,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

import {
  linkAttachmentToMessage,
  uploadAttachment,
} from "../memory/attachments-store.js";
import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function createTestUrl(conversationId: string): URL {
  return new URL(
    `http://localhost/v1/messages?conversationId=${conversationId}`,
  );
}

interface AttachmentPayload {
  data?: string;
  mimeType: string;
  thumbnailData?: string;
}

interface MessagePayload {
  attachments?: AttachmentPayload[];
}

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
const DOC_BASE64 = "JVBERi0xLjQKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwo";

describe("handleListMessages attachments", () => {
  beforeEach(resetTables);

  test("user message image attachments include base64 data", async () => {
    const conv = createConversation();
    const msg = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "check this image" }]),
    );
    const stored = uploadAttachment("photo.png", "image/png", IMAGE_BASE64);
    linkAttachmentToMessage(msg.id, stored.id, 0);

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(1);
    const attachments = body.messages[0].attachments;
    expect(attachments).toBeDefined();
    expect(attachments).toHaveLength(1);
    expect(attachments![0].mimeType).toBe("image/png");
    expect(attachments![0].data).toBe(IMAGE_BASE64);
  });

  test("user message non-image attachments stay metadata-only", async () => {
    const conv = createConversation();
    const msg = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "check this doc" }]),
    );
    const stored = uploadAttachment(
      "report.pdf",
      "application/pdf",
      DOC_BASE64,
    );
    linkAttachmentToMessage(msg.id, stored.id, 0);

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(1);
    const attachments = body.messages[0].attachments;
    expect(attachments).toBeDefined();
    expect(attachments).toHaveLength(1);
    expect(attachments![0].mimeType).toBe("application/pdf");
    // Non-image attachments should NOT include base64 data
    expect(attachments![0].data).toBeUndefined();
  });

  test("assistant message image attachments include base64 data", async () => {
    const conv = createConversation();
    const msg = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "here is an image" }]),
    );
    const stored = uploadAttachment("result.png", "image/png", IMAGE_BASE64);
    linkAttachmentToMessage(msg.id, stored.id, 0);

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(1);
    const attachments = body.messages[0].attachments;
    expect(attachments).toBeDefined();
    expect(attachments).toHaveLength(1);
    expect(attachments![0].mimeType).toBe("image/png");
    // Assistant image attachments include base64 data for inline rendering
    expect(attachments![0].data).toBe(IMAGE_BASE64);
  });

  test("user message with mixed attachments only inlines images", async () => {
    const conv = createConversation();
    const msg = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "here are files" }]),
    );
    const imgStored = uploadAttachment("photo.jpg", "image/jpeg", IMAGE_BASE64);
    const docStored = uploadAttachment(
      "doc.pdf",
      "application/pdf",
      DOC_BASE64,
    );
    linkAttachmentToMessage(msg.id, imgStored.id, 0);
    linkAttachmentToMessage(msg.id, docStored.id, 1);

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as { messages: MessagePayload[] };

    const attachments = body.messages[0].attachments!;
    expect(attachments).toHaveLength(2);

    const imgAtt = attachments.find((a) => a.mimeType === "image/jpeg");
    const docAtt = attachments.find((a) => a.mimeType === "application/pdf");
    expect(imgAtt!.data).toBe(IMAGE_BASE64);
    expect(docAtt!.data).toBeUndefined();
  });
});

describe("handleListMessages no_response filtering", () => {
  beforeEach(resetTables);

  test("strips <no_response/> from assistant message content", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "<no_response/>" }]),
    );

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as {
      messages: { content: string; textSegments: string[] }[];
    };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe("");
    // textSegments is omitted from payload when empty
    expect(body.messages[0].textSegments).toBeUndefined();
  });

  test("strips <no_response/> but keeps other text segments", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "text", text: "<no_response/>" },
        { type: "text", text: "Real reply." },
      ]),
    );

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as {
      messages: { content: string; textSegments: string[] }[];
    };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe("Real reply.");
    expect(body.messages[0].textSegments).toEqual(["Real reply."]);
  });

  test("remaps contentOrder when <no_response/> segment is removed", async () => {
    const conv = createConversation();
    // Simulate: text("<no_response/>") -> tool_use -> tool_result -> text("Answer")
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "text", text: "<no_response/>" },
        {
          type: "tool_use",
          id: "tu1",
          name: "search",
          input: { q: "test" },
        },
        { type: "tool_result", tool_use_id: "tu1", content: "result" },
        { type: "text", text: "Answer" },
      ]),
    );

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as {
      messages: {
        content: string;
        textSegments: string[];
        contentOrder: string[];
      }[];
    };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].textSegments).toEqual(["Answer"]);
    // text:0 (no_response) should be removed, text:1 remapped to text:0
    expect(body.messages[0].contentOrder).toContain("text:0");
    expect(body.messages[0].contentOrder).not.toContain("text:1");
  });

  test("does not strip <no_response/> from user messages", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "What does <no_response/> do?" }]),
    );

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as {
      messages: { content: string }[];
    };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe("What does <no_response/> do?");
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

interface PaginatedResponse {
  messages: { id: string; content: string; timestamp: string }[];
  hasMore?: boolean;
  oldestTimestamp?: number;
  oldestMessageId?: string;
}

function createPaginatedUrl(
  conversationId: string,
  params?: { limit?: string; beforeTimestamp?: string },
): URL {
  const url = new URL(
    `http://localhost/v1/messages?conversationId=${conversationId}`,
  );
  if (params?.limit !== undefined) url.searchParams.set("limit", params.limit);
  if (params?.beforeTimestamp !== undefined)
    url.searchParams.set("beforeTimestamp", params.beforeTimestamp);
  return url;
}

/** Helper: insert N messages with distinct, increasing timestamps and return them in insertion order. */
async function insertMessages(
  conversationId: string,
  count: number,
): Promise<{ id: string; createdAt: number }[]> {
  const msgs: { id: string; createdAt: number }[] = [];
  for (let i = 0; i < count; i++) {
    const msg = await addMessage(
      conversationId,
      i % 2 === 0 ? "user" : "assistant",
      JSON.stringify([{ type: "text", text: `msg-${i}` }]),
    );
    msgs.push({ id: msg.id, createdAt: msg.createdAt });
  }
  return msgs;
}

describe("handleListMessages pagination", () => {
  beforeEach(resetTables);

  test("no params → all messages, no hasMore field", async () => {
    const conv = createConversation();
    await insertMessages(conv.id, 5);

    const response = handleListMessages(createTestUrl(conv.id), null);
    const body = (await response.json()) as PaginatedResponse;

    expect(body.messages).toHaveLength(5);
    expect(body.hasMore).toBeUndefined();
    expect(body.oldestTimestamp).toBeUndefined();
    expect(body.oldestMessageId).toBeUndefined();
  });

  test("limit only (no beforeTimestamp) → all messages, no hasMore", async () => {
    const conv = createConversation();
    await insertMessages(conv.id, 5);

    const url = createPaginatedUrl(conv.id, { limit: "3" });
    const response = handleListMessages(url, null);
    const body = (await response.json()) as PaginatedResponse;

    // Option A: without beforeTimestamp, all messages are returned regardless of limit
    expect(body.messages).toHaveLength(5);
    expect(body.hasMore).toBeUndefined();
  });

  test("beforeTimestamp + limit → correct page with hasMore: true", async () => {
    const conv = createConversation();
    const msgs = await insertMessages(conv.id, 10);

    // Cursor is message[7]'s timestamp; limit=3 → should return messages [4,5,6]
    const url = createPaginatedUrl(conv.id, {
      beforeTimestamp: String(msgs[7].createdAt),
      limit: "3",
    });
    const response = handleListMessages(url, null);
    const body = (await response.json()) as PaginatedResponse;

    expect(body.messages).toHaveLength(3);
    expect(body.messages.map((m) => m.id)).toEqual([
      msgs[4].id,
      msgs[5].id,
      msgs[6].id,
    ]);
    expect(body.hasMore).toBe(true);
  });

  test("beforeTimestamp is strictly exclusive", async () => {
    const conv = createConversation();
    const msgs = await insertMessages(conv.id, 3);

    // Use message[1]'s exact timestamp as cursor — message[1] should NOT appear
    const url = createPaginatedUrl(conv.id, {
      beforeTimestamp: String(msgs[1].createdAt),
      limit: "10",
    });
    const response = handleListMessages(url, null);
    const body = (await response.json()) as PaginatedResponse;

    const ids = body.messages.map((m) => m.id);
    expect(ids).toContain(msgs[0].id);
    expect(ids).not.toContain(msgs[1].id);
    expect(ids).not.toContain(msgs[2].id);
  });

  test("hasMore: false when all older messages fit", async () => {
    const conv = createConversation();
    const msgs = await insertMessages(conv.id, 5);

    // beforeTimestamp beyond the last message, limit larger than total count
    const url = createPaginatedUrl(conv.id, {
      beforeTimestamp: String(msgs[4].createdAt + 1),
      limit: "10",
    });
    const response = handleListMessages(url, null);
    const body = (await response.json()) as PaginatedResponse;

    expect(body.messages).toHaveLength(5);
    expect(body.hasMore).toBe(false);
  });

  test("oldestTimestamp and oldestMessageId match oldest returned message", async () => {
    const conv = createConversation();
    const msgs = await insertMessages(conv.id, 5);

    // Fetch last 3 messages before a cursor past the end
    const url = createPaginatedUrl(conv.id, {
      beforeTimestamp: String(msgs[4].createdAt + 1),
      limit: "3",
    });
    const response = handleListMessages(url, null);
    const body = (await response.json()) as PaginatedResponse;

    expect(body.messages).toHaveLength(3);
    // Oldest returned message is msgs[2] (messages [2,3,4])
    expect(body.oldestTimestamp).toBe(msgs[2].createdAt);
    expect(body.oldestMessageId).toBe(msgs[2].id);
  });

  test("empty / nonexistent conversation → empty messages, no pagination metadata", async () => {
    const url = createPaginatedUrl("nonexistent-conv-id");
    const response = handleListMessages(url, null);
    const body = (await response.json()) as PaginatedResponse;

    expect(body.messages).toEqual([]);
    expect(body.hasMore).toBeUndefined();
    expect(body.oldestTimestamp).toBeUndefined();
    expect(body.oldestMessageId).toBeUndefined();
  });

  test("invalid limit (NaN) → 400", async () => {
    const conv = createConversation();
    const url = createPaginatedUrl(conv.id, { limit: "abc" });
    const response = handleListMessages(url, null);

    expect(response.status).toBe(400);
  });

  test("invalid beforeTimestamp (NaN) → 400", async () => {
    const conv = createConversation();
    const url = createPaginatedUrl(conv.id, { beforeTimestamp: "abc" });
    const response = handleListMessages(url, null);

    expect(response.status).toBe(400);
  });
});
