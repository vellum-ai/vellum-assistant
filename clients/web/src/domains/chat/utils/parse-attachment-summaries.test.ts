import { describe, expect, test } from "bun:test";

import { parseAttachmentSummariesFromContent } from "@/domains/chat/utils/parse-attachment-summaries";

describe("parseAttachmentSummariesFromContent", () => {
  test("returns input unchanged when no attachment marker is present", () => {
    const result = parseAttachmentSummariesFromContent("hello world");
    expect(result.cleanedContent).toBe("hello world");
    expect(result.attachments).toBeUndefined();
  });

  test("ignores the marker when it appears mid-line in user text", () => {
    const text = "I asked what [File attachment] means in the docs";
    const result = parseAttachmentSummariesFromContent(text);
    expect(result.cleanedContent).toBe(text);
    expect(result.attachments).toBeUndefined();
  });

  test("extracts a single attachment with size and strips the summary block", () => {
    const content =
      "can you read this\n[File attachment] Receipt-2967-4101-0157.pdf, type=application/pdf, size=32.1 KB";
    const result = parseAttachmentSummariesFromContent(content);
    expect(result.cleanedContent).toBe("can you read this");
    expect(result.attachments).toEqual([
      {
        id: "rehydrated:0",
        filename: "Receipt-2967-4101-0157.pdf",
        mimeType: "application/pdf",
        sizeBytes: Math.round(32.1 * 1024),
        previewUrl: null,
      },
    ]);
  });

  test("handles a leading attachment block with no preceding user text", () => {
    const content = "[File attachment] notes.txt, type=text/plain, size=512 B";
    const result = parseAttachmentSummariesFromContent(content);
    expect(result.cleanedContent).toBe("");
    expect(result.attachments?.[0]).toMatchObject({
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 512,
    });
  });

  test("parses multiple attachments and indexes their ids", () => {
    const content = [
      "see attached",
      "[File attachment] a.png, type=image/png, size=1.0 KB",
      "[File attachment] b.pdf, type=application/pdf, size=2.0 MB",
    ].join("\n");
    const result = parseAttachmentSummariesFromContent(content);
    expect(result.cleanedContent).toBe("see attached");
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments?.[0]).toMatchObject({
      id: "rehydrated:0",
      filename: "a.png",
      sizeBytes: 1024,
    });
    expect(result.attachments?.[1]).toMatchObject({
      id: "rehydrated:1",
      filename: "b.pdf",
      sizeBytes: 2 * 1024 * 1024,
    });
  });

  test("treats a missing size suffix as 0 bytes", () => {
    const content = "[File attachment] empty.bin, type=application/octet-stream";
    const result = parseAttachmentSummariesFromContent(content);
    expect(result.attachments?.[0]).toMatchObject({
      filename: "empty.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 0,
    });
  });

  test("discards 'Attachment text:' continuation lines from the cleaned content", () => {
    const content = [
      "review please",
      "[File attachment] spec.md, type=text/markdown, size=4 B",
      "Attachment text: # spec",
    ].join("\n");
    const result = parseAttachmentSummariesFromContent(content);
    expect(result.cleanedContent).toBe("review please");
    expect(result.attachments).toHaveLength(1);
  });
});
