/**
 * Regression test for the durable-downscale path of the image-too-large
 * recovery (JARVIS-1041 review follow-up).
 *
 * When an oversized stored image *can* be shrunk on this host (the common macOS
 * path where `sips` is available), `persistUnsendableImageDowngrades` must write
 * the downscaled bytes back to the DB — not leave the original in place. The
 * latest tool-result media is intentionally kept in context, so leaving the
 * full-size block would rehydrate and re-reject on every later turn instead of
 * durably self-healing the conversation.
 *
 * `optimizeImageForTransport` needs `sips` and a decodable image to actually
 * downscale, which is not portable to CI, so it is mocked here to simulate a
 * successful shrink. The mock is process-global, so this case lives in its own
 * file (the test runner isolates each file in its own process) to avoid
 * disturbing the no-op-resize cases in persist-unsendable-image.test.ts.
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
  upscaleImageToMinimum: () => null,
  optimizeImageForTransport: () => ({
    data: SHRUNK_DATA,
    mediaType: "image/jpeg",
  }),
}));

import {
  addMessage,
  createConversation,
  getMessages,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { persistUnsendableImageDowngrades } from "../plugins/defaults/image-recovery/recover.js";
import { base64Source } from "../providers/media-resolve.js";
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
    const rewritten = persistUnsendableImageDowngrades(conv.id);

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
    expect(persistUnsendableImageDowngrades(conv.id)).toBe(1);

    // WHEN the downgrade runs again
    const secondRun = persistUnsendableImageDowngrades(conv.id);

    // THEN nothing further is rewritten
    expect(secondRun).toBe(0);
  });
});
