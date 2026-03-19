import { describe, expect, test } from "bun:test";

import {
  attachmentsToContentBlocks,
  enrichMessageWithSourcePaths,
} from "../agent/attachments.js";
import { createUserMessage } from "../agent/message-types.js";

// ---------------------------------------------------------------------------
// attachmentsToContentBlocks
// ---------------------------------------------------------------------------

describe("attachmentsToContentBlocks", () => {
  test("creates image content block for image/jpeg", () => {
    const blocks = attachmentsToContentBlocks([
      { filename: "photo.jpg", mimeType: "image/jpeg", data: "base64data" },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("image");
    const block = blocks[0] as {
      type: "image";
      source: { type: string; media_type: string; data: string };
    };
    expect(block.source.type).toBe("base64");
    expect(block.source.media_type).toBe("image/jpeg");
    expect(block.source.data).toBe("base64data");
  });

  test("creates image content block for image/png", () => {
    const blocks = attachmentsToContentBlocks([
      { filename: "screenshot.png", mimeType: "image/png", data: "pngdata" },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("image");
  });

  test("creates image content block for image/webp", () => {
    const blocks = attachmentsToContentBlocks([
      { filename: "sticker.webp", mimeType: "image/webp", data: "webpdata" },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("image");
  });

  test("creates file content block for non-image mime types", () => {
    const blocks = attachmentsToContentBlocks([
      { filename: "doc.pdf", mimeType: "application/pdf", data: "pdfdata" },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("file");
    const block = blocks[0] as {
      type: "file";
      source: { filename: string; media_type: string; data: string };
    };
    expect(block.source.filename).toBe("doc.pdf");
    expect(block.source.media_type).toBe("application/pdf");
  });

  test("handles multiple attachments including mixed types", () => {
    const blocks = attachmentsToContentBlocks([
      { filename: "photo.jpg", mimeType: "image/jpeg", data: "imgdata" },
      { filename: "notes.txt", mimeType: "text/plain", data: "txtdata" },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("image");
    expect(blocks[1].type).toBe("file");
  });

  test("returns empty array for no attachments", () => {
    const blocks = attachmentsToContentBlocks([]);
    expect(blocks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createUserMessage with image attachments
// ---------------------------------------------------------------------------

describe("createUserMessage with image attachments", () => {
  test("includes both text and image blocks", () => {
    const msg = createUserMessage("what is this?", [
      { filename: "photo.jpg", mimeType: "image/jpeg", data: "base64img" },
    ]);

    expect(msg.role).toBe("user");
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0].type).toBe("text");
    expect((msg.content[0] as { type: "text"; text: string }).text).toBe(
      "what is this?",
    );
    expect(msg.content[1].type).toBe("image");
  });

  test("includes only image block when text is empty", () => {
    const msg = createUserMessage("", [
      { filename: "photo.jpg", mimeType: "image/jpeg", data: "base64img" },
    ]);

    expect(msg.role).toBe("user");
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0].type).toBe("image");
  });

  test("includes only image block when text is whitespace", () => {
    const msg = createUserMessage("   ", [
      { filename: "photo.jpg", mimeType: "image/jpeg", data: "base64img" },
    ]);

    expect(msg.role).toBe("user");
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0].type).toBe("image");
  });

  test("includes multiple image blocks", () => {
    const msg = createUserMessage("compare these", [
      { filename: "a.jpg", mimeType: "image/jpeg", data: "img1" },
      { filename: "b.png", mimeType: "image/png", data: "img2" },
    ]);

    expect(msg.role).toBe("user");
    expect(msg.content).toHaveLength(3);
    expect(msg.content[0].type).toBe("text");
    expect(msg.content[1].type).toBe("image");
    expect(msg.content[2].type).toBe("image");
  });

  test("preserves base64 data in image content block", () => {
    const base64 = "dGVzdC1pbWFnZS1kYXRh";
    const msg = createUserMessage("test", [
      { filename: "photo.jpg", mimeType: "image/jpeg", data: base64 },
    ]);

    const imageBlock = msg.content[1] as {
      type: "image";
      source: { type: string; media_type: string; data: string };
    };
    expect(imageBlock.source.data).toBe(base64);
    expect(imageBlock.source.media_type).toBe("image/jpeg");
    expect(imageBlock.source.type).toBe("base64");
  });
});

// ---------------------------------------------------------------------------
// enrichMessageWithSourcePaths
// ---------------------------------------------------------------------------

describe("enrichMessageWithSourcePaths", () => {
  test("appends a source path annotation for images with filePath", () => {
    const attachments = [
      {
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        data: "base64img",
        filePath: "/Users/me/Desktop/photo.jpg",
      },
    ];
    const original = createUserMessage("what is this?", attachments);
    const enriched = enrichMessageWithSourcePaths(original, attachments);

    expect(enriched).not.toBe(original);
    // Original has text + image = 2 blocks; enriched adds 1 annotation = 3
    expect(enriched.content).toHaveLength(3);
    const annotation = enriched.content[2] as { type: "text"; text: string };
    expect(annotation.type).toBe("text");
    expect(annotation.text).toBe(
      "[Attached image source: /Users/me/Desktop/photo.jpg]",
    );
  });

  test("returns the original message (same reference) when no images have filePath", () => {
    const attachments = [
      {
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        data: "base64img",
      },
    ];
    const original = createUserMessage("what is this?", attachments);
    const result = enrichMessageWithSourcePaths(original, attachments);

    expect(result).toBe(original);
  });

  test("skips non-image attachments with filePath", () => {
    const attachments = [
      {
        filename: "doc.pdf",
        mimeType: "application/pdf",
        data: "pdfdata",
        filePath: "/Users/me/Documents/doc.pdf",
      },
    ];
    const original = createUserMessage("review this", attachments);
    const result = enrichMessageWithSourcePaths(original, attachments);

    // Non-image attachments are not annotated, so we get back the same ref
    expect(result).toBe(original);
  });

  test("handles multiple images with file paths", () => {
    const attachments = [
      {
        filename: "a.jpg",
        mimeType: "image/jpeg",
        data: "img1",
        filePath: "/path/to/a.jpg",
      },
      {
        filename: "b.png",
        mimeType: "image/png",
        data: "img2",
        filePath: "/path/to/b.png",
      },
    ];
    const original = createUserMessage("compare", attachments);
    const enriched = enrichMessageWithSourcePaths(original, attachments);

    expect(enriched).not.toBe(original);
    // text + 2 images + 1 annotation = 4
    expect(enriched.content).toHaveLength(4);
    const annotation = enriched.content[3] as { type: "text"; text: string };
    expect(annotation.type).toBe("text");
    expect(annotation.text).toBe(
      "[Attached image source: /path/to/a.jpg]\n[Attached image source: /path/to/b.png]",
    );
  });

  test("only annotates images that have filePath, skips those without", () => {
    const attachments = [
      {
        filename: "a.jpg",
        mimeType: "image/jpeg",
        data: "img1",
        filePath: "/path/to/a.jpg",
      },
      {
        filename: "b.png",
        mimeType: "image/png",
        data: "img2",
        // no filePath — e.g. pasted screenshot
      },
    ];
    const original = createUserMessage("compare", attachments);
    const enriched = enrichMessageWithSourcePaths(original, attachments);

    expect(enriched).not.toBe(original);
    // text + 2 images + 1 annotation (only for a.jpg) = 4
    expect(enriched.content).toHaveLength(4);
    const annotation = enriched.content[3] as { type: "text"; text: string };
    expect(annotation.text).toBe("[Attached image source: /path/to/a.jpg]");
  });
});
