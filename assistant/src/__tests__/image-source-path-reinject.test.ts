import { describe, expect, test } from "bun:test";

import { reinjectImageSourcePaths } from "../daemon/conversation-lifecycle.js";
import type { ContentBlock } from "../providers/types.js";

// ---------------------------------------------------------------------------
// reinjectImageSourcePaths — re-inject [Attached image source: /path]
// annotations when loading conversation history from DB
// ---------------------------------------------------------------------------

describe("reinjectImageSourcePaths", () => {
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
    const result = reinjectImageSourcePaths(baseContent, "user", metadata);

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
    const result = reinjectImageSourcePaths(baseContent, "assistant", metadata);

    // Should return the original content unchanged
    expect(result).toBe(baseContent);
    expect(result).toHaveLength(2);
  });

  test("returns content unchanged when metadata is null", () => {
    const result = reinjectImageSourcePaths(baseContent, "user", null);
    expect(result).toBe(baseContent);
    expect(result).toHaveLength(2);
  });

  test("returns content unchanged when metadata has no imageSourcePaths", () => {
    const metadata = JSON.stringify({
      userMessageChannel: "desktop",
    });
    const result = reinjectImageSourcePaths(baseContent, "user", metadata);
    expect(result).toBe(baseContent);
    expect(result).toHaveLength(2);
  });

  test("returns content unchanged when imageSourcePaths is empty object", () => {
    const metadata = JSON.stringify({
      imageSourcePaths: {},
    });
    const result = reinjectImageSourcePaths(baseContent, "user", metadata);
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
    const result = reinjectImageSourcePaths(baseContent, "user", metadata);

    expect(result).toHaveLength(3);
    const annotation = result[2] as { type: "text"; text: string };
    expect(annotation.type).toBe("text");
    expect(annotation.text).toBe(
      "[Attached image source: /path/to/a.jpg]\n[Attached image source: /path/to/b.png]",
    );
  });

  test("gracefully handles malformed metadata JSON", () => {
    const result = reinjectImageSourcePaths(
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
    const result = reinjectImageSourcePaths(baseContent, "user", metadata);

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
    const result = reinjectImageSourcePaths(baseContent, "user", metadata);
    expect(result).toBe(baseContent);
    expect(result).toHaveLength(2);
  });

  test("preserves original content blocks in returned array", () => {
    const metadata = JSON.stringify({
      imageSourcePaths: { "photo.jpg": "/path/photo.jpg" },
    });
    const result = reinjectImageSourcePaths(baseContent, "user", metadata);

    // First two blocks should be identical to the originals
    expect(result[0]).toEqual(baseContent[0]);
    expect(result[1]).toEqual(baseContent[1]);
  });
});
