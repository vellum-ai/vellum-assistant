/**
 * Regression tests for the image-too-large persistence path (JARVIS-1037).
 *
 * An image the provider can never accept — over the per-side pixel cap or the
 * per-image byte cap, and not shrinkable on this host — must be durably swapped
 * for a text note in its stored message. If it stays in the stored content,
 * every later turn rehydrates it from the DB and the model reports seeing both
 * the rejected image and any smaller re-upload. `persistImageDowngrades`
 * makes the swap durable so the rejected upload cannot resurface.
 *
 * Uses the real SQLite DB wired up via `test-preload.ts` (per-file temp
 * workspace).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  addMessage,
  createConversation,
  getMessages,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  INVALID_IMAGE_NOTE,
  invalidImageReplacement,
  persistImageDowngrades,
  recoverImages,
  unprocessableImageReplacement,
  UNSENDABLE_IMAGE_NOTE,
  unsendableImageReplacement,
} from "../plugins/defaults/image-recovery/recover.js";
import type { ContentBlock, Message } from "../providers/types.js";

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

/**
 * Build a minimal PNG whose IHDR declares the given dimensions. Only the
 * 8-byte signature and the width/height fields (read by `parseImageDimensions`)
 * need to be correct; the rest is padding. `optimizeImageForTransport` cannot
 * downscale this off macOS (no `sips`), so it stays a no-op — exactly the
 * host condition that produces an unsendable stored image.
 */
function makePngBase64(width: number, height: number, padBytes = 0): string {
  const header = Buffer.from(
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
      0x00, // bit depth / color type / etc.
    ]),
  ).toString("base64");
  return padBytes > 0 ? header + "A".repeat(padBytes) : header;
}

function imageBlock(data: string): ContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  };
}

/**
 * A tool_result carrying a nested image in its contentBlocks, mirroring what a
 * browser screenshot produces. This is the JARVIS-1041 shape: the oversized
 * image lives at tool_result.contentBlocks, never as a top-level block.
 */
function toolResultWithImage(data: string): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: "toolu_123",
    content: "Screenshot captured",
    contentBlocks: [imageBlock(data)],
  };
}

function storedContent(conversationId: string): ContentBlock[][] {
  return getMessages(conversationId).map((row) => row.content);
}

const PROVIDER_MAX_IMAGE_DIMENSION = 8000;

describe("persistImageDowngrades", () => {
  beforeEach(() => {
    resetTables();
  });

  /** A stored image past the provider pixel cap is swapped for a text note. */
  test("replaces an oversized image block with a text note", async () => {
    // GIVEN a message holding text plus an image past the pixel cap
    const conv = createConversation();
    const oversized = makePngBase64(PROVIDER_MAX_IMAGE_DIMENSION + 1000, 6000);
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: "look at this" },
        imageBlock(oversized),
      ]),
      { skipIndexing: true },
    );

    // WHEN the downgrade is persisted
    const rewritten = persistImageDowngrades(
      conv.id,
      unsendableImageReplacement,
    );

    // THEN one message is rewritten with no image block left
    expect(rewritten).toBe(1);
    const [content] = storedContent(conv.id);
    expect(content.some((b) => b.type === "image")).toBe(false);
    // AND the original text is preserved alongside the substituted note
    expect(content.filter((b) => b.type === "text")).toHaveLength(2);
  });

  /** The JARVIS-1037 scenario: the rejected original must not resurface next
   *  to a valid re-upload. */
  test("re-uploaded smaller image survives while the rejected original is removed", async () => {
    // GIVEN turn 1 contains an oversized upload that was rejected
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([imageBlock(makePngBase64(12000, 9000))]),
      { skipIndexing: true },
    );
    // AND turn 2 contains a properly sized re-upload
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([imageBlock(makePngBase64(800, 600))]),
      { skipIndexing: true },
    );

    // WHEN the downgrade is persisted
    const rewritten = persistImageDowngrades(
      conv.id,
      unsendableImageReplacement,
    );

    // THEN only the rejected original is removed
    expect(rewritten).toBe(1);
    const [first, second] = storedContent(conv.id);
    expect(first.some((b) => b.type === "image")).toBe(false);
    // AND the valid re-upload is left intact
    expect(second.some((b) => b.type === "image")).toBe(true);
  });

  /** Sendable images are never disturbed by the recovery path. */
  test("leaves a normally-sized image untouched", async () => {
    // GIVEN a message with an image well within provider limits
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([imageBlock(makePngBase64(1024, 768))]),
      { skipIndexing: true },
    );

    // WHEN the downgrade is persisted
    const rewritten = persistImageDowngrades(
      conv.id,
      unsendableImageReplacement,
    );

    // THEN nothing is rewritten and the image remains
    expect(rewritten).toBe(0);
    const [content] = storedContent(conv.id);
    expect(content.some((b) => b.type === "image")).toBe(true);
  });

  /** The byte-size cap is enforced independently of pixel dimensions. */
  test("removes an image whose payload exceeds the per-image byte cap", async () => {
    // GIVEN an image within the pixel cap but with a payload over 5 MB
    const conv = createConversation();
    const huge = makePngBase64(1000, 1000, 6 * 1024 * 1024);
    await addMessage(conv.id, "user", JSON.stringify([imageBlock(huge)]), {
      skipIndexing: true,
    });

    // WHEN the downgrade is persisted
    const rewritten = persistImageDowngrades(
      conv.id,
      unsendableImageReplacement,
    );

    // THEN the oversized-payload image is removed
    expect(rewritten).toBe(1);
    const [content] = storedContent(conv.id);
    expect(content.some((b) => b.type === "image")).toBe(false);
  });

  /** The minimum-size floor is enforced alongside the oversized caps: an
   *  image the provider rejects with "Could not process image" (e.g. a
   *  16×14 px upload) must not rehydrate and re-reject on later turns. */
  test("removes an image below the minimum-size floor", async () => {
    // GIVEN a message holding a tiny image below the provider minimum
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([imageBlock(makePngBase64(16, 14))]),
      { skipIndexing: true },
    );

    // WHEN the downgrade is persisted
    const rewritten = persistImageDowngrades(
      conv.id,
      unsendableImageReplacement,
    );

    // THEN the undersized image is removed (upscale is a no-op on this host)
    expect(rewritten).toBe(1);
    const [content] = storedContent(conv.id);
    expect(content.some((b) => b.type === "image")).toBe(false);
  });

  /** JARVIS-1041: the oversized image is nested inside a tool_result (e.g. a
   *  browser screenshot), not a top-level block. The downgrade must descend
   *  into tool_result.contentBlocks and swap the nested image for a note, while
   *  keeping the tool_result itself intact so tool_use/tool_result pairing
   *  survives. */
  test("downgrades an oversized image nested in tool_result.contentBlocks", async () => {
    // GIVEN an assistant turn whose tool_result holds an oversized screenshot
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([toolResultWithImage(makePngBase64(12000, 9000))]),
      { skipIndexing: true },
    );

    // WHEN the downgrade is persisted
    const rewritten = persistImageDowngrades(
      conv.id,
      unsendableImageReplacement,
    );

    // THEN the message is rewritten with the nested image swapped for a note
    expect(rewritten).toBe(1);
    const [content] = storedContent(conv.id);
    const toolResult = content.find((b) => b.type === "tool_result");
    expect(toolResult).toBeDefined();
    // AND the tool_result is preserved (pairing intact) with no image left
    const nested = (toolResult as { contentBlocks?: ContentBlock[] })
      .contentBlocks;
    expect(nested?.some((b) => b.type === "image")).toBe(false);
    expect(nested?.some((b) => b.type === "text")).toBe(true);
  });

  /** A sendable nested screenshot is never disturbed. */
  test("leaves a normally-sized tool_result image untouched", async () => {
    // GIVEN a tool_result with an image well within provider limits
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([toolResultWithImage(makePngBase64(1024, 768))]),
      { skipIndexing: true },
    );

    // WHEN the downgrade is persisted
    const rewritten = persistImageDowngrades(
      conv.id,
      unsendableImageReplacement,
    );

    // THEN nothing is rewritten and the nested image remains
    expect(rewritten).toBe(0);
    const [content] = storedContent(conv.id);
    const toolResult = content.find((b) => b.type === "tool_result") as {
      contentBlocks?: ContentBlock[];
    };
    expect(toolResult.contentBlocks?.some((b) => b.type === "image")).toBe(
      true,
    );
  });

  /** Re-running after a rewrite is a safe no-op (no image blocks remain). */
  test("is idempotent — a second run rewrites nothing", async () => {
    // GIVEN a conversation whose oversized image has already been downgraded
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([imageBlock(makePngBase64(10000, 10000))]),
      { skipIndexing: true },
    );
    expect(persistImageDowngrades(conv.id, unsendableImageReplacement)).toBe(1);

    // WHEN the downgrade runs a second time
    const secondRun = persistImageDowngrades(
      conv.id,
      unsendableImageReplacement,
    );

    // THEN nothing further is rewritten
    expect(secondRun).toBe(0);
  });
});

describe("unsendableImageReplacement", () => {
  /** A still-sendable image must be left alone — never replaced with a note.
   *  This is the gate that keeps the in-memory recovery from discarding valid
   *  screenshots when only one image in the turn was actually oversized. */
  test("returns null for an image within the provider caps", () => {
    const sendable = imageBlock(makePngBase64(1024, 768)) as Extract<
      ContentBlock,
      { type: "image" }
    >;
    expect(unsendableImageReplacement(sendable)).toBeNull();
  });

  /** An image past the provider caps that cannot be shrunk on this host (fake
   *  PNG that sips cannot decode) collapses to the unsendable note. */
  test("returns the unsendable note when an oversized image cannot be shrunk", () => {
    const oversized = imageBlock(makePngBase64(12000, 9000)) as Extract<
      ContentBlock,
      { type: "image" }
    >;
    const replacement = unsendableImageReplacement(oversized);
    expect(replacement?.type).toBe("text");
  });

  /** An image below the provider's minimum-size floor (rejected with "Could
   *  not process image") that cannot be upscaled on this host collapses to
   *  the unsendable note, same as the oversized direction. */
  test("returns the unsendable note when an undersized image cannot be upscaled", () => {
    const undersized = imageBlock(makePngBase64(16, 14)) as Extract<
      ContentBlock,
      { type: "image" }
    >;
    const replacement = unsendableImageReplacement(undersized);
    expect(replacement?.type).toBe("text");
  });
});

/** Base64 payload for a page of HTML (a Slack auth interstitial), the exact
 *  shape that was stored under an image media type in the field incident. */
const HTML_AS_IMAGE_DATA = Buffer.from(
  "<!DOCTYPE html><html><head><title>Sign in</title></head><body>Redirecting…</body></html>",
).toString("base64");

/** Base64 payload whose magic bytes are a JPEG (SOI + APP0 marker). */
const JPEG_BYTES_DATA = Buffer.from(
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
).toString("base64");

function asImage(data: string): Extract<ContentBlock, { type: "image" }> {
  return imageBlock(data) as Extract<ContentBlock, { type: "image" }>;
}

describe("invalidImageReplacement", () => {
  /** Non-image bytes (HTML) stored under image/png can never decode — no
   *  relabeling helps, so the block collapses to the invalid-image note. */
  test("replaces non-image bytes (HTML) with the invalid-image note", () => {
    const replacement = invalidImageReplacement(asImage(HTML_AS_IMAGE_DATA));
    expect(replacement).toEqual({ type: "text", text: INVALID_IMAGE_NOTE });
  });

  /** A real image whose declared media type already agrees is left untouched
   *  so the caller can fall through to the size rule. */
  test("returns null for a valid PNG whose media type already agrees", () => {
    expect(invalidImageReplacement(asImage(makePngBase64(64, 64)))).toBeNull();
  });

  /** JPEG bytes mislabeled image/png have their media type corrected in place,
   *  keeping the same payload. */
  test("corrects the media type when the bytes disagree with the label", () => {
    const replacement = invalidImageReplacement(asImage(JPEG_BYTES_DATA));
    expect(replacement).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: JPEG_BYTES_DATA,
      },
    });
  });

  /** A mislabeled image that also violates a size cap must not survive as a
   *  relabeled-but-oversized image: recovery is one-shot per turn, so the size
   *  rule runs on the corrected image in the same pass (here the fake PNG
   *  cannot be resized, so it collapses to the unsendable note). */
  test("applies the size rule to a media-type-corrected image in the same pass", () => {
    const block: Extract<ContentBlock, { type: "image" }> = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: makePngBase64(PROVIDER_MAX_IMAGE_DIMENSION + 1000, 4000),
      },
    };
    const replacement = unprocessableImageReplacement(block);
    expect(replacement).toEqual({ type: "text", text: UNSENDABLE_IMAGE_NOTE });
  });
});

describe("unprocessable-image recovery (invalid bytes)", () => {
  beforeEach(() => {
    resetTables();
  });

  /** HTML-as-image/png is swapped for the note both in the working history and
   *  in the stored row, so it cannot rehydrate and re-reject on later turns. */
  test("replaces HTML-as-image with the note in-memory and durably", async () => {
    // GIVEN a stored turn whose image block is actually an HTML page.
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: "what is this?" },
        imageBlock(HTML_AS_IMAGE_DATA),
      ]),
      { skipIndexing: true },
    );

    // WHEN the working history is recovered in-memory
    const history: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          imageBlock(HTML_AS_IMAGE_DATA),
        ],
      },
    ];
    const recovered = recoverImages(history, unprocessableImageReplacement);

    // THEN the HTML payload is gone, replaced with the invalid-image note
    expect(JSON.stringify(recovered)).not.toContain(HTML_AS_IMAGE_DATA);
    expect(recovered[0].content).toContainEqual({
      type: "text",
      text: INVALID_IMAGE_NOTE,
    });

    // AND the durable rewrite removes it from the stored row too
    const rewritten = persistImageDowngrades(
      conv.id,
      unprocessableImageReplacement,
    );
    expect(rewritten).toBe(1);
    const [content] = storedContent(conv.id);
    expect(content.some((b) => b.type === "image")).toBe(false);
    expect(content).toContainEqual({ type: "text", text: INVALID_IMAGE_NOTE });
  });

  /** A valid PNG is never disturbed by the unprocessable rule. */
  test("leaves a valid PNG untouched", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([imageBlock(makePngBase64(1024, 768))]),
      { skipIndexing: true },
    );

    const rewritten = persistImageDowngrades(
      conv.id,
      unprocessableImageReplacement,
    );

    expect(rewritten).toBe(0);
    const [content] = storedContent(conv.id);
    expect(content.some((b) => b.type === "image")).toBe(true);
  });
});
