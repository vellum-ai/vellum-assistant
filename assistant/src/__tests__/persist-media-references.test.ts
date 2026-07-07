/**
 * Regression tests for ATL-991 (part 2): assistant/tool-generated media
 * (screenshots, generated images) is materialized into the attachment store and
 * persisted as workspace references, not inline base64 in `messages.content`.
 *
 * Uses the real SQLite DB wired up via `test-preload.ts` (per-file temp
 * workspace).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { referenceMediaBlocksForPersist } from "../daemon/persist-media-references.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb, getSqliteFrom } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { resolveMediaReferences } from "../providers/media-resolve.js";
import type { ContentBlock } from "../providers/types.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
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
      0x0a,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52,
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

async function newRow(): Promise<{
  conversationId: string;
  messageId: string;
}> {
  const conv = createConversation();
  const msg = await addMessage(conv.id, "user", "[]", { skipIndexing: true });
  return { conversationId: conv.id, messageId: msg.id };
}

describe("referenceMediaBlocksForPersist", () => {
  beforeEach(() => {
    resetTables();
  });

  test("references a base64 image nested in a tool_result", async () => {
    const { messageId } = await newRow();
    const png = makePngBase64(100, 60);
    const blocks: ContentBlock[] = [
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "Screenshot captured",
        contentBlocks: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: png },
          },
        ],
      },
    ];

    const [referenced] = referenceMediaBlocksForPersist(messageId, blocks);
    const nested = (
      referenced as Extract<ContentBlock, { type: "tool_result" }>
    ).contentBlocks![0] as Extract<ContentBlock, { type: "image" }>;

    expect(nested.source.type).toBe("attachment_ref");
    if (nested.source.type === "attachment_ref") {
      expect(nested.source.media_type).toBe("image/png");
      expect(nested.source.attachmentId).toBeTruthy();
      expect(nested.source.width).toBe(100);
      expect(nested.source.height).toBe(60);
      expect(
        (nested.source as unknown as { data?: string }).data,
      ).toBeUndefined();
    }

    // No base64 survives in the serialized row.
    expect(JSON.stringify(referenced)).not.toContain(png);

    // A linked attachment row was created for the screenshot.
    const links = getSqliteFrom(getDb())
      .query(
        "SELECT COUNT(*) AS c FROM message_attachments WHERE message_id = ?",
      )
      .get(messageId) as { c: number };
    expect(links.c).toBe(1);
  });

  test("the referenced tool_result resolves back to the original bytes", async () => {
    const { messageId } = await newRow();
    const png = makePngBase64(48, 48);
    const blocks: ContentBlock[] = [
      {
        type: "tool_result",
        tool_use_id: "toolu_2",
        content: "shot",
        contentBlocks: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: png },
          },
        ],
      },
    ];

    const referenced = referenceMediaBlocksForPersist(messageId, blocks);
    const [resolved] = resolveMediaReferences([
      { role: "user", content: referenced },
    ]);
    const nested = (
      resolved!.content[0] as Extract<ContentBlock, { type: "tool_result" }>
    ).contentBlocks![0] as Extract<ContentBlock, { type: "image" }>;

    expect(nested.source.type).toBe("base64");
    if (nested.source.type === "base64") {
      // The fake PNG cannot be downscaled off macOS, so bytes round-trip verbatim.
      expect(nested.source.data).toBe(png);
    }
  });

  test("references a model-emitted top-level image", async () => {
    const { messageId } = await newRow();
    const png = makePngBase64(20, 20);
    const blocks: ContentBlock[] = [
      { type: "text", text: "here is your image" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: png },
      },
    ];

    const referenced = referenceMediaBlocksForPersist(messageId, blocks);
    const image = referenced[1] as Extract<ContentBlock, { type: "image" }>;
    expect(image.source.type).toBe("attachment_ref");
    expect(JSON.stringify(referenced)).not.toContain(png);
  });

  test("leaves an already-referenced block untouched (idempotent shape)", async () => {
    const { messageId } = await newRow();
    const blocks: ContentBlock[] = [
      {
        type: "image",
        source: {
          type: "attachment_ref",
          media_type: "image/png",
          attachmentId: "att-existing",
          sizeBytes: 123,
        },
      },
    ];
    const referenced = referenceMediaBlocksForPersist(messageId, blocks);
    expect(referenced[0]).toEqual(blocks[0]);
    const links = getSqliteFrom(getDb())
      .query(
        "SELECT COUNT(*) AS c FROM message_attachments WHERE message_id = ?",
      )
      .get(messageId) as { c: number };
    expect(links.c).toBe(0);
  });
});
