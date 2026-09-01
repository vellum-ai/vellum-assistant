/**
 * Compaction must never bake invalid image bytes into the rebuilt history.
 *
 * Retained images are re-hydrated from the attachment store and re-optimized
 * at compaction time. If that pipeline yields bytes that no longer parse as an
 * image (e.g. a corrupt conversion-cache entry), embedding them would make the
 * provider reject EVERY subsequent turn with a 400: the conversation wedges
 * until the block is manually removed. `buildRetainedImageBlocks` drops such
 * payloads instead.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  buildRetainedImageBlocks,
  collectImageManifest,
} from "../context/compactor.js";
import { attachInlineAttachmentToMessage } from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

// 1x1 transparent PNG.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// Declared image/png, but the bytes are not any known image format:
// the stand-in for a corrupted payload surviving in the pipeline.
const GARBAGE_BASE64 = Buffer.from("definitely not an image").toString(
  "base64",
);

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

async function addImageMessage(
  conversationId: string,
  filename: string,
  dataBase64: string,
): Promise<void> {
  const inserted = await addMessage(
    conversationId,
    "user",
    JSON.stringify([{ type: "text", text: filename }]),
    {
      metadata: { provenanceTrustClass: "guardian" },
      skipIndexing: true,
    },
  );
  await attachInlineAttachmentToMessage(
    inserted.id,
    0,
    filename,
    "image/png",
    dataBase64,
  );
}

describe("buildRetainedImageBlocks corrupt-bytes gate", () => {
  beforeEach(resetTables);

  test("valid image bytes are retained", async () => {
    const conv = createConversation();
    await addImageMessage(conv.id, "good.png", PNG_1X1_BASE64);
    const manifest = collectImageManifest(conv.id, "guardian");

    const { blocks, resolved, missing } = await buildRetainedImageBlocks(
      ["good.png"],
      manifest,
    );

    expect(resolved).toEqual(["good.png"]);
    expect(missing).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source.type).toBe("base64");
  });

  test("bytes that do not parse as an image are dropped, not embedded", async () => {
    const conv = createConversation();
    await addImageMessage(conv.id, "corrupt.png", GARBAGE_BASE64);
    await addImageMessage(conv.id, "good.png", PNG_1X1_BASE64);
    const manifest = collectImageManifest(conv.id, "guardian");

    const { blocks, resolved, missing } = await buildRetainedImageBlocks(
      ["corrupt.png", "good.png"],
      manifest,
    );

    // The corrupt payload is dropped (not listed as manifest-missing, since
    // it resolved fine; its bytes were the problem) and the valid one
    // survives.
    expect(resolved).toEqual(["good.png"]);
    expect(missing).toEqual([]);
    expect(blocks).toHaveLength(1);
  });

  test("a truncated JPEG (valid SOI header, no EOI) is dropped", async () => {
    // A JPEG torn mid-write keeps its SOI header, so a format sniff alone
    // accepts it; the gate must also require an EOI marker.
    const tornJpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from("JFIF\0"),
      Buffer.alloc(64),
    ]).toString("base64");
    const conv = createConversation();
    await addImageMessage(conv.id, "torn.jpg", tornJpeg);
    const manifest = collectImageManifest(conv.id, "guardian");

    const { blocks, resolved, missing } = await buildRetainedImageBlocks(
      ["torn.jpg"],
      manifest,
    );

    expect(resolved).toEqual([]);
    expect(missing).toEqual([]);
    expect(blocks).toHaveLength(0);
  });

  test("a retained block carries the attachment id it rehydrated from", async () => {
    // The rebuilt block is inline bytes, so this id is the only handle left on
    // the row it came from. Camera-frame retention matches on it: without it a
    // frame compaction chose to keep would be invisible to every later pass.
    const conv = createConversation();
    await addImageMessage(conv.id, "good.png", PNG_1X1_BASE64);
    const manifest = collectImageManifest(conv.id, "guardian");

    const { blocks } = await buildRetainedImageBlocks(["good.png"], manifest);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]._attachmentId).toBe(manifest[0].attachmentId);
    expect(blocks[0]._attachmentId).toBeTruthy();
  });

  test("unresolvable filenames still land in missing", async () => {
    const conv = createConversation();
    await addImageMessage(conv.id, "good.png", PNG_1X1_BASE64);
    const manifest = collectImageManifest(conv.id, "guardian");

    const { blocks, resolved, missing } = await buildRetainedImageBlocks(
      ["never-uploaded.png", "good.png"],
      manifest,
    );

    expect(missing).toEqual(["never-uploaded.png"]);
    expect(resolved).toEqual(["good.png"]);
    expect(blocks).toHaveLength(1);
  });
});
