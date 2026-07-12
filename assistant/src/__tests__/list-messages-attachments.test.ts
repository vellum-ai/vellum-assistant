/**
 * Tests for handleListMessages attachment handling.
 *
 * Verifies that:
 * - User message image attachments include base64 data for client thumbnail generation
 * - User message non-image attachments stay metadata-only (no base64 blob)
 * - Assistant message image attachments include base64 data (same as user messages)
 * - Stored HEIF/HEIC rows are hydrated as JPEG display data (Chromium cannot
 *   decode HEIF); undecodable content falls back to the stored bytes
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

// Keep the memory system off so addMessage skips indexing side effects.
setConfig("memory", { enabled: false });

import { randomUUID } from "node:crypto";

import {
  linkAttachmentToMessage,
  uploadAttachment,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { rawRun } from "../persistence/raw-query.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";
import { fakeHeifHeaderBytes, makeHeicFixtureBytes } from "./heic-fixture.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function createTestArgs(conversationId: string) {
  return {
    queryParams: { conversationId },
  };
}

interface AttachmentPayload {
  data?: string;
  filename?: string;
  mimeType: string;
  kind?: string;
  thumbnailData?: string;
}

/**
 * Insert an attachment row directly, bypassing upload-time HEIF
 * normalization — simulates rows stored before normalization existed (or
 * where conversion was unavailable).
 */
function insertLegacyAttachmentRow(
  messageId: string,
  filename: string,
  mimeType: string,
  dataBase64: string,
  kind = "image",
): string {
  const id = randomUUID();
  rawRun(
    "test:insertAttachment",
    `INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    filename,
    mimeType,
    Buffer.from(dataBase64, "base64").length,
    kind,
    dataBase64,
    Date.now(),
  );
  linkAttachmentToMessage(messageId, id, 0);
  return id;
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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

    const attachments = body.messages[0].attachments!;
    expect(attachments).toHaveLength(2);

    const imgAtt = attachments.find((a) => a.mimeType === "image/jpeg");
    const docAtt = attachments.find((a) => a.mimeType === "application/pdf");
    expect(imgAtt!.data).toBe(IMAGE_BASE64);
    expect(docAtt!.data).toBeUndefined();
  });

  test("attachment-only assistant message synthesizes contentBlocks", async () => {
    // When the assistant's entire response was a <vellum-attachment/> tag,
    // parseDirectives strips it → cleanText is empty → renderHistoryContent
    // drops the empty text block → contentBlocks is []. The serializer must
    // synthesize attachment blocks from msgAttachments so the client has a
    // block to anchor the attachment chip.
    const conv = createConversation();
    // Persist the post-strip content: an empty text block (what
    // cleanAssistantContent leaves after stripping the directive tag).
    const msg = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "" }]),
    );
    const stored = uploadAttachment("output.png", "image/png", IMAGE_BASE64);
    linkAttachmentToMessage(msg.id, stored.id, 0);

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as {
      messages: {
        attachments?: AttachmentPayload[];
        contentBlocks?: Array<{
          type: string;
          attachment?: { id: string; filename: string };
        }>;
      }[];
    };

    expect(body.messages).toHaveLength(1);
    // Attachments are always on the wire
    expect(body.messages[0].attachments).toBeDefined();
    expect(body.messages[0].attachments).toHaveLength(1);
    // contentBlocks must be synthesized — not omitted
    expect(body.messages[0].contentBlocks).toBeDefined();
    expect(body.messages[0].contentBlocks).toHaveLength(1);
    expect(body.messages[0].contentBlocks![0].type).toBe("attachment");
    expect(body.messages[0].contentBlocks![0].attachment!.filename).toBe(
      "output.png",
    );
  });
});

describe("handleListMessages HEIC display normalization", () => {
  beforeEach(resetTables);

  test("undecodable HEIC data is served unchanged (conversion fallback)", async () => {
    const conv = createConversation();
    const msg = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "photo" }]),
    );
    const heicB64 = fakeHeifHeaderBytes().toString("base64");
    insertLegacyAttachmentRow(msg.id, "IMG_1.HEIC", "image/heic", heicB64);

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

    const attachments = body.messages[0].attachments!;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].mimeType).toBe("image/heic");
    expect(attachments[0].data).toBe(heicB64);
  });

  test("octet-stream HEIC stays metadata-only when conversion is unavailable", async () => {
    const conv = createConversation();
    const msg = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "photo" }]),
    );
    // Web-uploader fallback for an empty File.type: HEIC bytes land under
    // application/octet-stream and classify as a document. Fake header bytes
    // never convert, so the row must stay metadata-only rather than ship
    // unrenderable bytes as display data.
    const heicB64 = fakeHeifHeaderBytes().toString("base64");
    insertLegacyAttachmentRow(
      msg.id,
      "IMG_3.HEIC",
      "application/octet-stream",
      heicB64,
      "document",
    );

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as { messages: MessagePayload[] };

    const attachments = body.messages[0].attachments!;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].mimeType).toBe("application/octet-stream");
    expect(attachments[0].kind).toBe("document");
    expect(attachments[0].data).toBeUndefined();
  });

  describe.skipIf(process.platform !== "darwin")(
    "real conversion (sips)",
    () => {
      test("legacy HEIC rows are hydrated as JPEG display data", async () => {
        const heic = makeHeicFixtureBytes();
        expect(heic).not.toBeNull();

        const conv = createConversation();
        const msg = await addMessage(
          conv.id,
          "user",
          JSON.stringify([{ type: "text", text: "photo" }]),
        );
        insertLegacyAttachmentRow(
          msg.id,
          "IMG_2.HEIC",
          "image/heic",
          heic!.toString("base64"),
        );

        const response = handleListMessages(createTestArgs(conv.id));
        const body = response as { messages: MessagePayload[] };

        const attachments = body.messages[0].attachments!;
        expect(attachments).toHaveLength(1);
        expect(attachments[0].mimeType).toBe("image/jpeg");
        // JPEG SOI marker (FF D8 FF) base64-encodes to "/9j/".
        expect(attachments[0].data!.startsWith("/9j/")).toBe(true);
        // Metadata keeps describing the stored original, which the content
        // endpoint serves verbatim for downloads.
        expect(attachments[0].filename).toBe("IMG_2.HEIC");
      });

      test("legacy octet-stream HEIC rows hydrate as JPEG display data", async () => {
        const heic = makeHeicFixtureBytes();
        expect(heic).not.toBeNull();

        const conv = createConversation();
        const msg = await addMessage(
          conv.id,
          "user",
          JSON.stringify([{ type: "text", text: "photo" }]),
        );
        // Real HEIC bytes stored under application/octet-stream (empty
        // File.type fallback) and classified as a document — the row is
        // detected by its filename extension and converted for display.
        insertLegacyAttachmentRow(
          msg.id,
          "IMG_4.HEIC",
          "application/octet-stream",
          heic!.toString("base64"),
          "document",
        );

        const response = handleListMessages(createTestArgs(conv.id));
        const body = response as { messages: MessagePayload[] };

        const attachments = body.messages[0].attachments!;
        expect(attachments).toHaveLength(1);
        expect(attachments[0].mimeType).toBe("image/jpeg");
        expect(attachments[0].data!.startsWith("/9j/")).toBe(true);
        // The converted row presents as an image so clients render it inline.
        expect(attachments[0].kind).toBe("image");
        // The stored original filename is preserved for verbatim download.
        expect(attachments[0].filename).toBe("IMG_4.HEIC");
      });
    },
  );
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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as {
      messages: { textSegments?: string[] }[];
    };

    expect(body.messages).toHaveLength(1);
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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as {
      messages: { textSegments?: string[] }[];
    };

    expect(body.messages).toHaveLength(1);
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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as {
      messages: {
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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as {
      messages: { textSegments?: string[] }[];
    };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].textSegments).toEqual([
      "What does <no_response/> do?",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

interface PaginatedResponse {
  messages: { id: string; timestamp: string }[];
  hasMore?: boolean;
  oldestTimestamp?: number;
  oldestMessageId?: string;
}

function createPaginatedArgs(
  conversationId: string,
  params?: { limit?: string; beforeTimestamp?: string },
) {
  const queryParams: Record<string, string> = { conversationId };
  if (params?.limit !== undefined) {
    queryParams.limit = params.limit;
  }
  if (params?.beforeTimestamp !== undefined) {
    queryParams.beforeTimestamp = params.beforeTimestamp;
  }
  return { queryParams };
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

    const response = handleListMessages(createTestArgs(conv.id));
    const body = response as unknown as PaginatedResponse;

    expect(body.messages).toHaveLength(5);
    expect(body.hasMore).toBeUndefined();
    expect(body.oldestTimestamp).toBeUndefined();
    expect(body.oldestMessageId).toBeUndefined();
  });

  test("limit only (no beforeTimestamp) → all messages, no hasMore", async () => {
    const conv = createConversation();
    await insertMessages(conv.id, 5);

    const args = createPaginatedArgs(conv.id, { limit: "3" });
    const response = handleListMessages(args);
    const body = response as unknown as PaginatedResponse;

    // Option A: without beforeTimestamp, all messages are returned regardless of limit
    expect(body.messages).toHaveLength(5);
    expect(body.hasMore).toBeUndefined();
  });

  test("beforeTimestamp + limit → correct page with hasMore: true", async () => {
    const conv = createConversation();
    const msgs = await insertMessages(conv.id, 10);

    // Cursor is message[7]'s timestamp; limit=3 → should return messages [4,5,6]
    const args = createPaginatedArgs(conv.id, {
      beforeTimestamp: String(msgs[7].createdAt),
      limit: "3",
    });
    const response = handleListMessages(args);
    const body = response as unknown as PaginatedResponse;

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
    const args = createPaginatedArgs(conv.id, {
      beforeTimestamp: String(msgs[1].createdAt),
      limit: "10",
    });
    const response = handleListMessages(args);
    const body = response as unknown as PaginatedResponse;

    const ids = body.messages.map((m) => m.id);
    expect(ids).toContain(msgs[0].id);
    expect(ids).not.toContain(msgs[1].id);
    expect(ids).not.toContain(msgs[2].id);
  });

  test("hasMore: false when all older messages fit", async () => {
    const conv = createConversation();
    const msgs = await insertMessages(conv.id, 5);

    // beforeTimestamp beyond the last message, limit larger than total count
    const args = createPaginatedArgs(conv.id, {
      beforeTimestamp: String(msgs[4].createdAt + 1),
      limit: "10",
    });
    const response = handleListMessages(args);
    const body = response as unknown as PaginatedResponse;

    expect(body.messages).toHaveLength(5);
    expect(body.hasMore).toBe(false);
  });

  test("oldestTimestamp and oldestMessageId match oldest returned message", async () => {
    const conv = createConversation();
    const msgs = await insertMessages(conv.id, 5);

    // Fetch last 3 messages before a cursor past the end
    const args = createPaginatedArgs(conv.id, {
      beforeTimestamp: String(msgs[4].createdAt + 1),
      limit: "3",
    });
    const response = handleListMessages(args);
    const body = response as unknown as PaginatedResponse;

    expect(body.messages).toHaveLength(3);
    // Oldest returned message is msgs[2] (messages [2,3,4])
    expect(body.oldestTimestamp).toBe(msgs[2].createdAt);
    expect(body.oldestMessageId).toBe(msgs[2].id);
  });

  test("empty / nonexistent conversation → empty messages, no pagination metadata", async () => {
    const args = createPaginatedArgs("nonexistent-conv-id");
    const response = handleListMessages(args);
    const body = response as unknown as PaginatedResponse;

    expect(body.messages).toEqual([]);
    expect(body.hasMore).toBeUndefined();
    expect(body.oldestTimestamp).toBeUndefined();
    expect(body.oldestMessageId).toBeUndefined();
  });

  test("invalid limit (NaN) → 400", async () => {
    const conv = createConversation();
    const args = createPaginatedArgs(conv.id, { limit: "abc" });

    expect(() => handleListMessages(args)).toThrow(
      "limit must be a valid number",
    );
  });

  test("invalid beforeTimestamp (NaN) → 400", async () => {
    const conv = createConversation();
    const args = createPaginatedArgs(conv.id, { beforeTimestamp: "abc" });

    expect(() => handleListMessages(args)).toThrow(
      "beforeTimestamp must be a valid number",
    );
  });
});
