import { describe, expect, test } from "bun:test";

import { enrichMessageWithSourcePaths } from "../agent/attachments.js";
import { createUserMessage } from "../agent/message-types.js";
import { reinjectAttachmentPathAnnotations } from "../daemon/conversation-lifecycle.js";
import {
  extractAttachmentStoredPaths,
  extractImageSourcePaths,
} from "../persistence/conversation-crud.js";
import type { ContentBlock } from "../providers/types.js";

// ---------------------------------------------------------------------------
// reinjectAttachmentPathAnnotations — re-inject attachment path annotations
// (image source paths + resolved stored paths) when loading conversation
// history from DB
// ---------------------------------------------------------------------------

describe("reinjectAttachmentPathAnnotations", () => {
  const baseContent: ContentBlock[] = [
    { type: "text", text: "what is this?" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "base64img" },
    },
  ];

  test("adds annotation when user message has imageSourcePaths in metadata", () => {
    const metadata = JSON.stringify({
      imageSourcePaths: { "photo.jpg": "/Users/me/Desktop/photo.jpg" },
    });
    const result = reinjectAttachmentPathAnnotations(
      baseContent,
      "user",
      metadata,
    );

    expect(result).toHaveLength(3);
    const annotation = result[2] as { type: "text"; text: string };
    expect(annotation.type).toBe("text");
    expect(annotation.text).toBe(
      "[Attached image source: /Users/me/Desktop/photo.jpg]",
    );
  });

  test("does NOT annotate assistant messages even if metadata has imageSourcePaths", () => {
    const metadata = JSON.stringify({
      imageSourcePaths: { "photo.jpg": "/Users/me/Desktop/photo.jpg" },
    });
    const result = reinjectAttachmentPathAnnotations(
      baseContent,
      "assistant",
      metadata,
    );

    // Should return the original content unchanged
    expect(result).toBe(baseContent);
    expect(result).toHaveLength(2);
  });

  test("returns content unchanged when metadata is null", () => {
    const result = reinjectAttachmentPathAnnotations(baseContent, "user", null);
    expect(result).toBe(baseContent);
    expect(result).toHaveLength(2);
  });

  test("returns content unchanged when metadata has no imageSourcePaths", () => {
    const metadata = JSON.stringify({
      userMessageChannel: "desktop",
    });
    const result = reinjectAttachmentPathAnnotations(
      baseContent,
      "user",
      metadata,
    );
    expect(result).toBe(baseContent);
    expect(result).toHaveLength(2);
  });

  test("returns content unchanged when imageSourcePaths is empty object", () => {
    const metadata = JSON.stringify({
      imageSourcePaths: {},
    });
    const result = reinjectAttachmentPathAnnotations(
      baseContent,
      "user",
      metadata,
    );
    expect(result).toBe(baseContent);
    expect(result).toHaveLength(2);
  });

  test("handles multiple image source paths", () => {
    const metadata = JSON.stringify({
      imageSourcePaths: {
        "a.jpg": "/path/to/a.jpg",
        "b.png": "/path/to/b.png",
      },
    });
    const result = reinjectAttachmentPathAnnotations(
      baseContent,
      "user",
      metadata,
    );

    expect(result).toHaveLength(3);
    const annotation = result[2] as { type: "text"; text: string };
    expect(annotation.type).toBe("text");
    expect(annotation.text).toBe(
      "[Attached image source: /path/to/a.jpg]\n[Attached image source: /path/to/b.png]",
    );
  });

  test("gracefully handles malformed metadata JSON", () => {
    const result = reinjectAttachmentPathAnnotations(
      baseContent,
      "user",
      "not-valid-json{{{",
    );
    // Should return original content, not throw
    expect(result).toBe(baseContent);
    expect(result).toHaveLength(2);
  });

  test("filters out non-string values in imageSourcePaths", () => {
    const metadata = JSON.stringify({
      imageSourcePaths: {
        "photo.jpg": "/Users/me/Desktop/photo.jpg",
        "bad.jpg": 42,
        "also_bad.jpg": null,
      },
    });
    const result = reinjectAttachmentPathAnnotations(
      baseContent,
      "user",
      metadata,
    );

    expect(result).toHaveLength(3);
    const annotation = result[2] as { type: "text"; text: string };
    expect(annotation.text).toBe(
      "[Attached image source: /Users/me/Desktop/photo.jpg]",
    );
  });

  test("returns content unchanged when imageSourcePaths has only non-string values", () => {
    const metadata = JSON.stringify({
      imageSourcePaths: {
        "bad.jpg": 42,
        "also_bad.jpg": null,
      },
    });
    const result = reinjectAttachmentPathAnnotations(
      baseContent,
      "user",
      metadata,
    );
    expect(result).toBe(baseContent);
    expect(result).toHaveLength(2);
  });

  test("preserves original content blocks in returned array", () => {
    const metadata = JSON.stringify({
      imageSourcePaths: { "photo.jpg": "/path/photo.jpg" },
    });
    const result = reinjectAttachmentPathAnnotations(
      baseContent,
      "user",
      metadata,
    );

    // First two blocks should be identical to the originals
    expect(result[0]).toEqual(baseContent[0]);
    expect(result[1]).toEqual(baseContent[1]);
  });

  test("adds stored path annotations from attachmentStoredPaths", () => {
    const metadata = JSON.stringify({
      attachmentStoredPaths: {
        "0:report.pdf": "/conv/attachments/report-2.pdf",
      },
    });
    const result = reinjectAttachmentPathAnnotations(
      baseContent,
      "user",
      metadata,
    );

    expect(result).toHaveLength(3);
    const annotation = result[2] as { type: "text"; text: string };
    expect(annotation.text).toBe(
      '[Attachment "report.pdf" is stored at: /conv/attachments/report-2.pdf]',
    );
  });

  test("recovers filenames containing colons from stored path keys", () => {
    const metadata = JSON.stringify({
      attachmentStoredPaths: {
        "0:notes: draft.txt": "/conv/attachments/notes: draft.txt",
      },
    });
    const result = reinjectAttachmentPathAnnotations(
      baseContent,
      "user",
      metadata,
    );

    const annotation = result[2] as { type: "text"; text: string };
    expect(annotation.text).toBe(
      '[Attachment "notes: draft.txt" is stored at: /conv/attachments/notes: draft.txt]',
    );
  });

  test("emits image source lines before stored path lines in one block", () => {
    const metadata = JSON.stringify({
      imageSourcePaths: { "1:photo.jpg": "/Users/me/Desktop/photo.jpg" },
      attachmentStoredPaths: {
        "0:data.csv": "/conv/attachments/data-2.csv",
        "1:photo.jpg": "/conv/attachments/photo.jpg",
      },
    });
    const result = reinjectAttachmentPathAnnotations(
      baseContent,
      "user",
      metadata,
    );

    expect(result).toHaveLength(3);
    const annotation = result[2] as { type: "text"; text: string };
    expect(annotation.text).toBe(
      "[Attached image source: /Users/me/Desktop/photo.jpg]\n" +
        '[Attachment "data.csv" is stored at: /conv/attachments/data-2.csv]\n' +
        '[Attachment "photo.jpg" is stored at: /conv/attachments/photo.jpg]',
    );
  });

  test("rebuilds the exact annotation block enrichMessageWithSourcePaths appends", () => {
    // Prefix-cache parity tripwire: the block appended at persist time (from
    // live attachment inputs) and the block rebuilt on history reload (from
    // persisted metadata) must be byte-identical.
    const attachments = [
      {
        filename: "data.csv",
        mimeType: "text/csv",
        data: "csvdata",
        storedPath: "/conv/attachments/data-2.csv",
      },
      {
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        data: "img",
        filePath: "/Users/me/Desktop/photo.jpg",
        storedPath: "/conv/attachments/photo.jpg",
      },
    ];
    const enriched = enrichMessageWithSourcePaths(
      createUserMessage("compare", attachments),
      attachments,
    );
    const liveBlock = enriched.content.at(-1) as {
      type: "text";
      text: string;
    };

    const metadata = JSON.stringify({
      imageSourcePaths: extractImageSourcePaths(attachments),
      attachmentStoredPaths: extractAttachmentStoredPaths(attachments),
    });
    const rebuilt = reinjectAttachmentPathAnnotations(
      [{ type: "text", text: "compare" }],
      "user",
      metadata,
    );
    const rebuiltBlock = rebuilt.at(-1) as { type: "text"; text: string };

    expect(rebuiltBlock.text).toBe(liveBlock.text);
  });
});
