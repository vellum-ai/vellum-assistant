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
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
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
