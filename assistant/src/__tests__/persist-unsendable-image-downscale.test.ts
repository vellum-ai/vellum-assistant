/**
 * Regression test for the durable-downscale path of the image-too-large
 * recovery (JARVIS-1041 review follow-up).
 *
 * When an oversized stored image can be shrunk,
 * `persistUnsendableImageDowngrades` must write the downscaled bytes back to
 * the DB, not leave the original in place. The
 * latest tool-result media is intentionally kept in context, so leaving the
 * full-size block would rehydrate and re-reject on every later turn instead of
 * durably self-healing the conversation.
 *
 * The encoder is mocked here to isolate the durable persistence behavior from
 * image decoding. The mock is process-global, so this case lives in its own
 * file to avoid disturbing the no-op resize cases.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mock (must precede the import of the module under test) ────
// Simulate a host where resizing succeeds: any oversized image is shrunk to a
// small, distinct JPEG payload. durableImageReplacement checks the provider
// caps before calling this, so in-limit images never reach the mock.
const SHRUNK_DATA = "c2hydW5r"; // base64 for "shrunk"
mock.module("../agent/image-optimize.js", () => ({
  // The gate helper must stay real-shaped: every image in this file is
  // oversized (never undersized), so the min-dimension gate never matches
  // and the rejection-path upscale is never reached.
  isBelowMinDimension: () => false,
  upscaleImageToMinimum: async () => null,
  optimizeImageForTransport: async () => ({
    data: SHRUNK_DATA,
    mediaType: "image/jpeg",
  }),
}));

import { uploadAttachment } from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
  getMessages,
} from "../persistence/conversation-crud.js";
import { getDb, getMemorySqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  persistUnsendableImageDowngrades,
  unsendableImageReplacement,
} from "../plugins/defaults/image-recovery/recover.js";
import { base64Source } from "../providers/media-resolve.js";
import type { ContentBlock } from "../providers/types.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  getMemorySqlite()?.run("DELETE FROM memory_segments");
  getMemorySqlite()?.run("DELETE FROM memory_embeddings");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/** Minimal PNG whose IHDR declares dimensions past the 8000px provider cap. */
function oversizedPngBase64(): string {
  const width = 12000;
  const height = 9000;
  return Buffer.from(
    Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR length (13)
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

function toolResultWithImage(data: string): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: "toolu_123",
    content: "Screenshot captured",
    contentBlocks: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data },
      },
    ],
  };
}

function storedContent(conversationId: string): ContentBlock[][] {
  return getMessages(conversationId).map((row) => row.content);
}

describe("persistUnsendableImageDowngrades (downscalable host)", () => {
  beforeEach(() => {
    resetTables();
  });

  /** JARVIS-1041: an oversized screenshot that CAN be shrunk must persist the
   *  downscaled bytes, not the note and not the original. */
  test("persists the downscaled image for a shrinkable tool_result screenshot", async () => {
    // GIVEN a tool_result holding an oversized but shrinkable screenshot
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([toolResultWithImage(oversizedPngBase64())]),
      { skipIndexing: true },
    );

    // WHEN the downgrade is persisted
    const rewritten = await persistUnsendableImageDowngrades(conv.id);

    // THEN the nested block stays an image, rewritten to the downscaled payload
    expect(rewritten).toBe(1);
    const [content] = storedContent(conv.id);
    const toolResult = content.find((b) => b.type === "tool_result") as {
      contentBlocks?: ContentBlock[];
    };
    const nested = toolResult.contentBlocks?.[0];
    expect(nested?.type).toBe("image");
    expect(
      base64Source((nested as Extract<ContentBlock, { type: "image" }>).source)
        .data,
    ).toBe(SHRUNK_DATA);
  });

  /** The resize replaces the block's whole source, so a reference-backed image
   *  loses `source.attachmentId` along with the reference. The id has to be
   *  derived from either shape and re-stamped, or the durable rewrite untags a
   *  camera frame permanently. */
  test("a resized workspace_ref keeps its attachment id on the rebuilt block", async () => {
    const stored = await uploadAttachment(
      "frame.png",
      "image/png",
      oversizedPngBase64(),
    );
    const referenceBlock = {
      type: "image",
      source: {
        type: "workspace_ref",
        media_type: "image/png",
        attachmentId: stored.id,
        sizeBytes: 128,
        // Persisted references carry the dimension hints the provider caps are
        // judged against (see `attachmentsToReferenceBlocks`).
        width: 12000,
        height: 9000,
      },
    } as Extract<ContentBlock, { type: "image" }>;

    const replacement = await unsendableImageReplacement(referenceBlock);

    // The source was flattened to the shrunk inline bytes...
    expect(replacement).toMatchObject({
      type: "image",
      source: { type: "base64", data: SHRUNK_DATA },
    });
    // ...and the link to the attachment row survived the flattening.
    expect((replacement as { _attachmentId?: string })._attachmentId).toBe(
      stored.id,
    );
  });

  /** An inline resize input carries its id on the top-level field instead. */
  test("a resized inline block keeps its top-level attachment id", async () => {
    const inlineBlock = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: oversizedPngBase64(),
      },
      _attachmentId: "att-inline-1",
    } as Extract<ContentBlock, { type: "image" }>;

    const replacement = await unsendableImageReplacement(inlineBlock);

    expect(replacement).toMatchObject({
      type: "image",
      source: { type: "base64", data: SHRUNK_DATA },
      _attachmentId: "att-inline-1",
    });
  });

  /** Re-running is a no-op: the downscaled payload is within limits. */
  test("is idempotent after a downscale rewrite", async () => {
    // GIVEN a conversation whose oversized screenshot was already downscaled
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([toolResultWithImage(oversizedPngBase64())]),
      { skipIndexing: true },
    );
    expect(await persistUnsendableImageDowngrades(conv.id)).toBe(1);

    // WHEN the downgrade runs again
    const secondRun = await persistUnsendableImageDowngrades(conv.id);

    // THEN nothing further is rewritten
    expect(secondRun).toBe(0);
  });
});
