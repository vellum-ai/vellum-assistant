import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, test } from "bun:test";

import { optimizeImageForTransport } from "../agent/image-optimize.js";
import {
  createInlineAttachment,
  linkAttachmentToMessage,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
  deleteConversation,
  getConversation,
  getMessages,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { migrateMaterializeHistoricalInlineMessageMedia } from "../persistence/migrations/351-materialize-historical-inline-message-media.js";
import { resolveMediaReferences } from "../providers/media-resolve.js";
import type { ContentBlock } from "../providers/types.js";

await initializeDb();

let conversationId: string | null = null;

afterEach(() => {
  if (conversationId && getConversation(conversationId)) {
    deleteConversation(conversationId);
  }
  conversationId = null;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, checksum]);
}

function sparsePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe.skipIf(process.platform !== "darwin")(
  "historical inline optimized image replay",
  () => {
    test("keeps the workspace reference aligned with original attachment bytes", async () => {
      const originalPng = sparsePng(2000, 100);
      const historicalInline = optimizeImageForTransport(
        originalPng.toString("base64"),
        "image/png",
      );
      expect(historicalInline.mediaType).toBe("image/jpeg");

      const conversation = createConversation("Historical media thread");
      conversationId = conversation.id;
      const attachment = createInlineAttachment(
        conversation.id,
        conversation.createdAt,
        "original.png",
        "image/png",
        originalPng.toString("base64"),
      );
      const message = await addMessage(
        conversation.id,
        "user",
        JSON.stringify([
          {
            type: "image",
            source: {
              type: "base64",
              media_type: historicalInline.mediaType,
              data: historicalInline.data,
            },
          },
        ] satisfies ContentBlock[]),
        { skipIndexing: true },
      );
      linkAttachmentToMessage(message.id, attachment.id, 0);

      await migrateMaterializeHistoricalInlineMessageMedia(getDb(), {
        yieldToEventLoop: async () => {},
      });

      const migratedImage = getMessages(conversation.id)[0]!
        .content[0] as Extract<ContentBlock, { type: "image" }>;
      expect(migratedImage.source.type).toBe("workspace_ref");
      if (migratedImage.source.type !== "workspace_ref") {
        throw new Error("expected migrated workspace reference");
      }
      expect(migratedImage.source.media_type).toBe("image/png");
      expect(migratedImage.source.sizeBytes).toBe(originalPng.length);

      const replayedImage = resolveMediaReferences([
        { role: "user", content: [migratedImage] },
      ])[0]!.content[0] as Extract<ContentBlock, { type: "image" }>;
      expect(replayedImage.source.type).toBe("base64");
      if (replayedImage.source.type !== "base64") {
        throw new Error("expected replayed base64 image");
      }
      expect(replayedImage.source.media_type).toBe(historicalInline.mediaType);
      expect(replayedImage.source.data).toBe(historicalInline.data);
    });
  },
);
