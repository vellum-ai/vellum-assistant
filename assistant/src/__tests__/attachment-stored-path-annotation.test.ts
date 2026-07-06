/**
 * Regression: re-uploading a document with the same filename must not leave
 * the model pointing at the older upload. Storage resolves the collision with
 * a -2/-3 suffix in the conversation's attachments/ directory, so the
 * LLM-facing user message (and the metadata used to rebuild it on history
 * reload) must carry the resolved stored path of every linked attachment —
 * otherwise the model's only on-disk handle is the original filename, which
 * stays bound to the oldest upload.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, mock, test } from "bun:test";

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

import { reinjectAttachmentPathAnnotations } from "../daemon/conversation-lifecycle.js";
import type { MessagingConversationContext } from "../daemon/conversation-messaging.js";
import { persistQueuedMessageBody } from "../daemon/conversation-messaging.js";
import { createConversation } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { rawGet } from "../persistence/raw-query.js";
import type { ContentBlock } from "../providers/types.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function makeCtx(conversationId: string): MessagingConversationContext {
  return {
    conversationId,
    messages: [],
    abortController: null,
    currentRequestId: undefined,
    queue: {} as never,
    isProcessing: () => false,
    setProcessing: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
  } as unknown as MessagingConversationContext;
}

function lastAnnotationBlock(ctx: MessagingConversationContext): {
  type: string;
  text: string;
} {
  const llmMessage = ctx.messages.at(-1)!;
  return (llmMessage.content as ContentBlock[]).at(-1) as {
    type: string;
    text: string;
  };
}

describe("persistQueuedMessageBody stored path annotations", () => {
  beforeEach(resetTables);

  test("same-named re-upload annotates the resolved -2 path", async () => {
    const conv = createConversation();
    const ctx = makeCtx(conv.id);

    // "aGVsbG8=" = "hello", "d29ybGQ=" = "world"
    const first = await persistQueuedMessageBody(ctx, {
      content: "here is my file",
      attachments: [
        { filename: "report.csv", mimeType: "text/csv", data: "aGVsbG8=" },
      ],
    });
    const second = await persistQueuedMessageBody(ctx, {
      content: "I edited it, take another look",
      attachments: [
        { filename: "report.csv", mimeType: "text/csv", data: "d29ybGQ=" },
      ],
    });

    // Second turn's persisted metadata records the collision-suffixed copy.
    const row = rawGet<{ metadata: string }>(
      "test:secondMessageMetadata",
      "SELECT metadata FROM messages WHERE id = ?",
      second.id,
    );
    const meta = JSON.parse(row!.metadata) as {
      attachmentStoredPaths: Record<string, string>;
    };
    const storedPath = meta.attachmentStoredPaths["0:report.csv"];
    expect(storedPath.endsWith("report-2.csv")).toBe(true);
    expect(readFileSync(storedPath).toString()).toBe("world");

    // The in-memory LLM message points at that copy, not the original name.
    const annotation = lastAnnotationBlock(ctx);
    expect(annotation.type).toBe("text");
    expect(annotation.text).toBe(
      `[Attachment "report.csv" is stored at: ${storedPath}]`,
    );

    // The first turn's annotation still points at the unsuffixed original.
    const firstRow = rawGet<{ metadata: string }>(
      "test:firstMessageMetadata",
      "SELECT metadata FROM messages WHERE id = ?",
      first.id,
    );
    const firstMeta = JSON.parse(firstRow!.metadata) as {
      attachmentStoredPaths: Record<string, string>;
    };
    const firstStoredPath = firstMeta.attachmentStoredPaths["0:report.csv"];
    expect(firstStoredPath.endsWith("report.csv")).toBe(true);
    expect(firstStoredPath.endsWith("report-2.csv")).toBe(false);
    expect(readFileSync(firstStoredPath).toString()).toBe("hello");

    // History-reload parity: reinjection rebuilds the identical block.
    const rebuilt = reinjectAttachmentPathAnnotations(
      [{ type: "text", text: "I edited it, take another look" }],
      "user",
      row!.metadata,
    );
    const rebuiltBlock = rebuilt.at(-1) as { type: "text"; text: string };
    expect(rebuiltBlock.text).toBe(annotation.text);
  });

  test("messages without attachments get no annotation block", async () => {
    const conv = createConversation();
    const ctx = makeCtx(conv.id);

    await persistQueuedMessageBody(ctx, { content: "just text" });

    expect(ctx.messages).toHaveLength(1);
    const content = ctx.messages[0].content as ContentBlock[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });
});
