/**
 * Regression tests for ATL-991: uploaded attachments are persisted into
 * `messages.content` as workspace *references* (attachment id + size/dimension
 * hints), never inline base64. The bytes live in the attachment store and are
 * resolved back at the provider boundary (and for any stored-content byte
 * reader) on demand.
 *
 * Uses the real SQLite DB wired up via `test-preload.ts` (per-file temp
 * workspace).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { persistUserMessageRow } from "../daemon/conversation-messaging.js";
import {
  createConversation,
  getMessages,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { extractMediaBlocks } from "../persistence/message-content.js";
import { resolveMediaReferences } from "../providers/media-resolve.js";
import type { ContentBlock } from "../providers/types.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM memory_segments");
  db.run("DELETE FROM memory_embeddings");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/** Minimal PNG whose IHDR declares the given pixel dimensions. */
function makePngBase64(width: number, height: number): string {
  return Buffer.from(
    Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // signature
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR length
      0x49,
      0x48,
      0x44,
      0x52, // "IHDR"
      (width >>> 24) & 0xff,
      (width >>> 16) & 0xff,
      (width >>> 8) & 0xff,
      width & 0xff,
      (height >>> 24) & 0xff,
      (height >>> 16) & 0xff,
      (height >>> 8) & 0xff,
      height & 0xff,
      0x08,
      0x06,
      0x00,
      0x00,
      0x00,
    ]),
  ).toString("base64");
}

function storedBlocks(conversationId: string): {
  raw: string;
  blocks: ContentBlock[];
} {
  const [row] = getMessages(conversationId);
  return {
    raw: row!.content,
    blocks: JSON.parse(row!.content) as ContentBlock[],
  };
}

describe("attachment reference persistence", () => {
  beforeEach(() => {
    resetTables();
  });

  test("persists an uploaded image as a reference, not inline base64", async () => {
    const conv = createConversation();
    const pngBase64 = makePngBase64(120, 80);

    await persistUserMessageRow({
      conversationId: conv.id,
      content: "look at this diagram",
      attachmentInputs: [
        { filename: "diagram.png", mimeType: "image/png", data: pngBase64 },
      ],
    });

    const { raw, blocks } = storedBlocks(conv.id);

    // The base64 payload must not appear anywhere in the stored row.
    expect(raw).not.toContain(pngBase64);

    const imageBlock = blocks.find((b) => b.type === "image");
    expect(imageBlock).toBeDefined();
    const source = (imageBlock as Extract<ContentBlock, { type: "image" }>)
      .source;
    expect(source.type).toBe("attachment_ref");
    if (source.type === "attachment_ref") {
      expect(source.media_type).toBe("image/png");
      expect(source.attachmentId).toBeTruthy();
      expect(source.sizeBytes).toBeGreaterThan(0);
      // Dimension hints let the token estimator cost the image without a disk read.
      expect(source.width).toBe(120);
      expect(source.height).toBe(80);
      expect((source as unknown as { data?: string }).data).toBeUndefined();
    }
  });

  test("resolveMediaReferences rehydrates the reference to inline base64", async () => {
    const conv = createConversation();
    const pngBase64 = makePngBase64(64, 64);

    await persistUserMessageRow({
      conversationId: conv.id,
      content: "resolve me",
      attachmentInputs: [
        { filename: "shot.png", mimeType: "image/png", data: pngBase64 },
      ],
    });

    const { blocks } = storedBlocks(conv.id);
    const [resolved] = resolveMediaReferences([
      { role: "user", content: blocks },
    ]);
    const resolvedImage = resolved!.content.find((b) => b.type === "image");
    const resolvedSource = (
      resolvedImage as Extract<ContentBlock, { type: "image" }>
    ).source;

    expect(resolvedSource.type).toBe("base64");
    if (resolvedSource.type === "base64") {
      // The fake PNG cannot be downscaled off macOS, so the resolved bytes are
      // the stored bytes verbatim.
      expect(resolvedSource.data).toBe(pngBase64);
      expect(resolvedSource.media_type).toBe("image/png");
    }
  });

  test("extractMediaBlocks resolves reference bytes from the attachment store", async () => {
    const conv = createConversation();
    const pngBase64 = makePngBase64(32, 48);

    await persistUserMessageRow({
      conversationId: conv.id,
      content: "index me",
      attachmentInputs: [
        { filename: "thumb.png", mimeType: "image/png", data: pngBase64 },
      ],
    });

    const { raw } = storedBlocks(conv.id);
    const media = extractMediaBlocks(raw);
    expect(media).toHaveLength(1);
    expect(media[0]!.mimeType).toBe("image/png");
    expect(media[0]!.data.toString("base64")).toBe(pngBase64);
  });
});
