import { describe, expect, test } from "bun:test";

import { PROVIDER_STRING_OMITTED_NOTE } from "./content-block-size.js";
import { fileBlockToProviderText } from "./file-block-text.js";
import type { ContentBlock } from "./types.js";

function fileBlock(
  mediaType: string,
  extractedText?: string,
): Extract<ContentBlock, { type: "file" }> {
  return {
    type: "file",
    source: {
      type: "workspace_ref",
      media_type: mediaType,
      attachmentId: "att-1",
      sizeBytes: 12,
      filename: "clip.mp4",
    },
    ...(extractedText !== undefined ? { extracted_text: extractedText } : {}),
  };
}

describe("fileBlockToProviderText", () => {
  test("names a video without dumping extracted_text", () => {
    const text = fileBlockToProviderText(
      fileBlock("video/mp4", "a".repeat(1000)),
    );
    expect(text).toContain("video/mp4");
    expect(text).toContain("workspace file");
    expect(text).not.toContain("aaa");
  });

  test("includes extracted_text for a non-video file under the cap", () => {
    const text = fileBlockToProviderText({
      type: "file",
      source: {
        type: "workspace_ref",
        media_type: "application/pdf",
        attachmentId: "att-2",
        sizeBytes: 20,
        filename: "notes.pdf",
      },
      extracted_text: "quarterly summary",
    });
    expect(text).toContain("quarterly summary");
  });

  test("omits an over-cap extracted_text dump", () => {
    const text = fileBlockToProviderText({
      type: "file",
      source: {
        type: "workspace_ref",
        media_type: "text/plain",
        attachmentId: "att-3",
        sizeBytes: 20,
        filename: "huge.txt",
      },
      extracted_text: "x".repeat(8_000_001),
    });
    expect(text).toBe(PROVIDER_STRING_OMITTED_NOTE);
    expect(text.length).toBeLessThan(200);
  });
});
