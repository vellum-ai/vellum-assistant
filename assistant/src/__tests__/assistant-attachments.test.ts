import { describe, expect, test } from "bun:test";

import {
  type AssistantAttachmentDraft,
  classifyKind,
  cleanAssistantContent,
  contentBlocksToDrafts,
  deduplicateDrafts,
  drainDirectiveDisplayBuffer,
  estimateBase64Bytes,
  inferMimeType,
  MAX_ASSISTANT_ATTACHMENT_BYTES,
  validateDrafts,
} from "../daemon/assistant-attachments.js";

// ---------------------------------------------------------------------------
// estimateBase64Bytes
// ---------------------------------------------------------------------------

describe("estimateBase64Bytes", () => {
  test("returns 0 for empty string", () => {
    expect(estimateBase64Bytes("")).toBe(0);
  });

  test("handles no-padding base64", () => {
    // "abc" → base64 "YWJj" (4 chars, 0 padding → 3 bytes)
    expect(estimateBase64Bytes("YWJj")).toBe(3);
  });

  test("handles single-pad base64", () => {
    // "ab" → base64 "YWI=" (4 chars, 1 padding → 2 bytes)
    expect(estimateBase64Bytes("YWI=")).toBe(2);
  });

  test("handles double-pad base64", () => {
    // "a" → base64 "YQ==" (4 chars, 2 padding → 1 byte)
    expect(estimateBase64Bytes("YQ==")).toBe(1);
  });

  test("estimates correctly for longer strings", () => {
    // 12 base64 chars, no padding → 9 bytes
    expect(estimateBase64Bytes("SGVsbG8gV29y")).toBe(9);
  });

  test("trims trailing whitespace and newlines before estimating", () => {
    // "a" → base64 "YQ==" → 1 byte; trailing newline should not affect result
    expect(estimateBase64Bytes("YQ==\n")).toBe(1);
    expect(estimateBase64Bytes("YQ==\r\n")).toBe(1);
    expect(estimateBase64Bytes("  YQ==  ")).toBe(1);
  });

  test("handles embedded line breaks in base64 (e.g. PEM-style)", () => {
    // "YWJj" split across lines should still yield 3 bytes
    expect(estimateBase64Bytes("YW\nJj")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// inferMimeType
// ---------------------------------------------------------------------------

describe("inferMimeType", () => {
  test("infers image types", () => {
    expect(inferMimeType("photo.png")).toBe("image/png");
    expect(inferMimeType("photo.jpg")).toBe("image/jpeg");
    expect(inferMimeType("photo.jpeg")).toBe("image/jpeg");
    expect(inferMimeType("sticker.webp")).toBe("image/webp");
    expect(inferMimeType("icon.gif")).toBe("image/gif");
    expect(inferMimeType("diagram.svg")).toBe("image/svg+xml");
  });

  test("infers document types", () => {
    expect(inferMimeType("report.pdf")).toBe("application/pdf");
    expect(inferMimeType("data.json")).toBe("application/json");
    expect(inferMimeType("notes.txt")).toBe("text/plain");
    expect(inferMimeType("readme.md")).toBe("text/markdown");
    expect(inferMimeType("table.csv")).toBe("text/csv");
  });

  test("is case-insensitive on extension", () => {
    expect(inferMimeType("PHOTO.PNG")).toBe("image/png");
    expect(inferMimeType("Report.PDF")).toBe("application/pdf");
  });

  test("returns octet-stream for unknown extension", () => {
    expect(inferMimeType("file.xyz")).toBe("application/octet-stream");
  });

  test("returns octet-stream for no extension", () => {
    expect(inferMimeType("Makefile")).toBe("application/octet-stream");
  });

  test("uses last extension for double-dotted names", () => {
    expect(inferMimeType("archive.tar.gz")).toBe("application/gzip");
  });
});

// ---------------------------------------------------------------------------
// classifyKind
// ---------------------------------------------------------------------------

describe("classifyKind", () => {
  test("classifies image mime types as image", () => {
    expect(classifyKind("image/png")).toBe("image");
    expect(classifyKind("image/jpeg")).toBe("image");
    expect(classifyKind("image/webp")).toBe("image");
  });

  test("classifies video mime types as video", () => {
    expect(classifyKind("video/mp4")).toBe("video");
    expect(classifyKind("video/webm")).toBe("video");
    expect(classifyKind("video/quicktime")).toBe("video");
  });

  test("classifies non-image non-video mime types as document", () => {
    expect(classifyKind("application/pdf")).toBe("document");
    expect(classifyKind("text/plain")).toBe("document");
    expect(classifyKind("application/octet-stream")).toBe("document");
  });
});

// ---------------------------------------------------------------------------
// validateDrafts
// ---------------------------------------------------------------------------

function makeDraft(
  overrides: Partial<AssistantAttachmentDraft> = {},
): AssistantAttachmentDraft {
  return {
    sourceType: "sandbox_file",
    filename: "test.txt",
    mimeType: "text/plain",
    dataBase64: "dGVzdA==",
    sizeBytes: 4,
    kind: "document",
    ...overrides,
  };
}

describe("validateDrafts", () => {
  test("accepts drafts within limits", () => {
    const drafts = [
      makeDraft({ filename: "a.txt" }),
      makeDraft({ filename: "b.txt" }),
    ];
    const result = validateDrafts(drafts);
    expect(result.accepted).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);
  });

  test("rejects oversized attachments", () => {
    const drafts = [
      makeDraft({
        filename: "big.bin",
        sizeBytes: MAX_ASSISTANT_ATTACHMENT_BYTES + 1,
      }),
    ];
    const result = validateDrafts(drafts);
    expect(result.accepted).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("big.bin");
    expect(result.warnings[0]).toContain("exceeds");
  });

  test("accepts many drafts without count limit", () => {
    const drafts = Array.from({ length: 20 }, (_, i) =>
      makeDraft({ filename: `file-${i}.txt` }),
    );
    const result = validateDrafts(drafts);
    expect(result.accepted).toHaveLength(20);
    expect(result.warnings).toHaveLength(0);
  });

  test("rejects oversized while accepting all valid drafts", () => {
    const drafts = [
      makeDraft({
        filename: "big.bin",
        sizeBytes: MAX_ASSISTANT_ATTACHMENT_BYTES + 1,
      }),
      ...Array.from({ length: 10 }, (_, i) =>
        makeDraft({ filename: `ok-${i}.txt` }),
      ),
    ];
    const result = validateDrafts(drafts);
    expect(result.accepted).toHaveLength(10);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("big.bin");
  });

  test("returns empty accepted for empty input", () => {
    const result = validateDrafts([]);
    expect(result.accepted).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("accepts a 25 MB attachment (under 50 MB limit)", () => {
    const drafts = [
      makeDraft({
        filename: "video.mov",
        sizeBytes: 25 * 1024 * 1024,
      }),
    ];
    const result = validateDrafts(drafts);
    expect(result.accepted).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  test("rejects a 51 MB attachment with warning mentioning 50.0 MB limit", () => {
    const drafts = [
      makeDraft({
        filename: "huge.mov",
        sizeBytes: 51 * 1024 * 1024,
      }),
    ];
    const result = validateDrafts(drafts);
    expect(result.accepted).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("huge.mov");
    expect(result.warnings[0]).toContain("50.0 MB");
    expect(result.warnings[0]).toContain("limit");
  });
});

// ---------------------------------------------------------------------------
// cleanAssistantContent
// ---------------------------------------------------------------------------

describe("cleanAssistantContent", () => {
  test("strips directives from text blocks and returns them", () => {
    const content = [
      {
        type: "text",
        text: 'Here is the file:\n<vellum-attachment path="out.png" />',
      },
    ];
    const result = cleanAssistantContent(content);

    expect(result.directives).toHaveLength(1);
    expect(result.directives[0].path).toBe("out.png");
    expect((result.cleanedContent[0] as { text: string }).text).toBe(
      "Here is the file:",
    );
  });

  test("leaves non-text blocks unchanged", () => {
    const content = [
      { type: "tool_use", id: "t1", name: "read", input: {} },
      { type: "text", text: '<vellum-attachment path="x.pdf" />' },
    ];
    const result = cleanAssistantContent(content);

    expect(result.cleanedContent[0]).toEqual(content[0]);
    expect(result.directives).toHaveLength(1);
  });

  test("accumulates warnings for malformed tags", () => {
    const content = [
      { type: "text", text: '<vellum-attachment source="bad" path="x.txt" />' },
    ];
    const result = cleanAssistantContent(content);

    expect(result.directives).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("invalid source");
  });

  test("preserves whitespace in plain text blocks without directives", () => {
    const content = [{ type: "text", text: "  Hello\n\n\n\nWorld  " }];
    const result = cleanAssistantContent(content);

    expect(result.directives).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    // Text should be returned exactly as-is — no trimming or blank-line collapsing
    expect((result.cleanedContent[0] as { text: string }).text).toBe(
      "  Hello\n\n\n\nWorld  ",
    );
  });

  test("handles content with no text blocks", () => {
    const content = [{ type: "thinking", thinking: "hmm", signature: "sig" }];
    const result = cleanAssistantContent(content);

    expect(result.directives).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.cleanedContent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// drainDirectiveDisplayBuffer
// ---------------------------------------------------------------------------

describe("drainDirectiveDisplayBuffer", () => {
  test("strips complete valid directives from streamed text", () => {
    const input = 'Before <vellum-attachment path="out.png" /> After';
    const result = drainDirectiveDisplayBuffer(input);
    expect(result.emitText).toBe("Before  After");
    expect(result.bufferedRemainder).toBe("");
  });

  test("inserts space when inline directive is stripped with no surrounding whitespace", () => {
    const input = 'sentence.<vellum-attachment path="out.png" />Next sentence.';
    const result = drainDirectiveDisplayBuffer(input);
    expect(result.emitText).toBe("sentence. Next sentence.");
    expect(result.bufferedRemainder).toBe("");
  });

  test("does not insert space when stripped directive already has trailing whitespace", () => {
    const input =
      'sentence. <vellum-attachment path="out.png" />Next sentence.';
    const result = drainDirectiveDisplayBuffer(input);
    expect(result.emitText).toBe("sentence. Next sentence.");
    expect(result.bufferedRemainder).toBe("");
  });

  test("does not insert space when stripped directive already has leading whitespace on next char", () => {
    const input =
      'sentence.<vellum-attachment path="out.png" /> Next sentence.';
    const result = drainDirectiveDisplayBuffer(input);
    expect(result.emitText).toBe("sentence. Next sentence.");
    expect(result.bufferedRemainder).toBe("");
  });

  test("preserves invalid directives as plain text", () => {
    const input = 'Bad <vellum-attachment source="bad" path="x.txt" /> tag';
    const result = drainDirectiveDisplayBuffer(input);
    expect(result.emitText).toBe(input);
    expect(result.bufferedRemainder).toBe("");
  });

  test("buffers incomplete directives until completion", () => {
    const first = drainDirectiveDisplayBuffer(
      'Start <vellum-attachment path="file',
    );
    expect(first.emitText).toBe("Start ");
    expect(first.bufferedRemainder).toContain("<vellum-attachment");

    const second = drainDirectiveDisplayBuffer(
      first.bufferedRemainder + '.png" /> done',
    );
    expect(second.emitText).toBe(" done");
    expect(second.bufferedRemainder).toBe("");
  });

  test('buffers trailing partial prefix "<" split across chunks', () => {
    const result = drainDirectiveDisplayBuffer("Hello world<");
    expect(result.emitText).toBe("Hello world");
    expect(result.bufferedRemainder).toBe("<");
  });

  test('buffers trailing partial prefix "<vel" split across chunks', () => {
    const result = drainDirectiveDisplayBuffer("Some text<vel");
    expect(result.emitText).toBe("Some text");
    expect(result.bufferedRemainder).toBe("<vel");
  });

  test('buffers trailing partial prefix "<vellum-attachmen" (one char short)', () => {
    const result = drainDirectiveDisplayBuffer("Data <vellum-attachmen");
    expect(result.emitText).toBe("Data ");
    expect(result.bufferedRemainder).toBe("<vellum-attachmen");
  });

  test('does not buffer trailing "<" that is not a prefix of the tag', () => {
    // "<x" does not match any prefix of "<vellum-attachment"
    const result = drainDirectiveDisplayBuffer("Hello<x");
    expect(result.emitText).toBe("Hello<x");
    expect(result.bufferedRemainder).toBe("");
  });

  test("partial prefix reassembles into a complete directive across chunks", () => {
    const first = drainDirectiveDisplayBuffer("Before <vellum-at");
    expect(first.emitText).toBe("Before ");
    expect(first.bufferedRemainder).toBe("<vellum-at");

    const second = drainDirectiveDisplayBuffer(
      first.bufferedRemainder + 'tachment path="out.png" /> After',
    );
    expect(second.emitText).toBe(" After");
    expect(second.bufferedRemainder).toBe("");
  });

  test("emits everything when text has no partial prefix", () => {
    const result = drainDirectiveDisplayBuffer("No special chars here");
    expect(result.emitText).toBe("No special chars here");
    expect(result.bufferedRemainder).toBe("");
  });
});

// ---------------------------------------------------------------------------
// contentBlocksToDrafts
// ---------------------------------------------------------------------------

describe("contentBlocksToDrafts", () => {
  test("converts image content block to draft", () => {
    const blocks = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0K" },
      },
    ];
    const drafts = contentBlocksToDrafts(blocks);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].sourceType).toBe("tool_block");
    expect(drafts[0].filename).toBe("tool-output.png");
    expect(drafts[0].mimeType).toBe("image/png");
    expect(drafts[0].kind).toBe("image");
  });

  test("converts file content block to draft", () => {
    const blocks = [
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "JVBER",
          filename: "report.pdf",
        },
      },
    ];
    const drafts = contentBlocksToDrafts(blocks);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].sourceType).toBe("tool_block");
    expect(drafts[0].filename).toBe("report.pdf");
    expect(drafts[0].kind).toBe("document");
  });

  test("skips non-image/file blocks", () => {
    const blocks = [
      { type: "text", text: "hello" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "/9j/" },
      },
    ];
    const drafts = contentBlocksToDrafts(blocks);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].mimeType).toBe("image/jpeg");
  });

  test("returns empty for empty input", () => {
    expect(contentBlocksToDrafts([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deduplicateDrafts
// ---------------------------------------------------------------------------

describe("validateDrafts with reversed tool drafts", () => {
  test("all tool screenshots accepted after reversing", () => {
    const totalScreenshots = 8;
    const toolDrafts = Array.from({ length: totalScreenshots }, (_, i) =>
      makeDraft({
        sourceType: "tool_block",
        filename: `screenshot-step-${i}.png`,
        mimeType: "image/png",
        kind: "image",
        dataBase64: `data${i}`,
      }),
    );

    toolDrafts.reverse();

    const result = validateDrafts(toolDrafts);
    expect(result.accepted).toHaveLength(totalScreenshots);
    expect(result.warnings).toHaveLength(0);
  });
});

describe("deduplicateDrafts", () => {
  test("removes exact duplicates with same filename and content", () => {
    const d = makeDraft({
      filename: "same.txt",
      dataBase64: "AAAA".repeat(20),
    });
    const result = deduplicateDrafts([
      d,
      { ...d },
      makeDraft({ filename: "other.txt" }),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].filename).toBe("same.txt");
    expect(result[1].filename).toBe("other.txt");
  });

  test("drops tool_block duplicate when directive has same content", () => {
    // Simulates directive tag ("chart.png") + auto-converted tool block
    // ("tool-output.png") for the same file data — the directive draft
    // should win because it appears first in the merged array.
    const data = "AAAA".repeat(20);
    const directive = makeDraft({
      sourceType: "sandbox_file",
      filename: "chart.png",
      dataBase64: data,
    });
    const toolBlock = makeDraft({
      sourceType: "tool_block",
      filename: "tool-output.png",
      dataBase64: data,
    });
    const result = deduplicateDrafts([directive, toolBlock]);

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe("chart.png");
  });

  test("keeps non-tool drafts with different filenames but identical content", () => {
    // Two distinct files that happen to have the same bytes (e.g. empty
    // files, or before.json / after.json with identical content) should
    // both be kept.
    const data = "AAAA".repeat(20);
    const d1 = makeDraft({
      sourceType: "sandbox_file",
      filename: "before.json",
      dataBase64: data,
    });
    const d2 = makeDraft({
      sourceType: "sandbox_file",
      filename: "after.json",
      dataBase64: data,
    });
    const result = deduplicateDrafts([d1, d2]);

    expect(result).toHaveLength(2);
    expect(result[0].filename).toBe("before.json");
    expect(result[1].filename).toBe("after.json");
  });

  test("keeps drafts with same filename but different content", () => {
    const d1 = makeDraft({
      filename: "file.txt",
      dataBase64: "AAAA".repeat(20),
    });
    const d2 = makeDraft({
      filename: "file.txt",
      dataBase64: "BBBB".repeat(20),
    });
    const result = deduplicateDrafts([d1, d2]);

    expect(result).toHaveLength(2);
  });

  test("keeps drafts with same filename and same prefix but different content", () => {
    // Shared 64-char prefix but different suffix — old prefix-based dedup
    // would incorrectly drop the second draft.
    const sharedPrefix = "A".repeat(64);
    const d1 = makeDraft({
      filename: "tool-output.png",
      dataBase64: sharedPrefix + "XXXX",
    });
    const d2 = makeDraft({
      filename: "tool-output.png",
      dataBase64: sharedPrefix + "YYYY",
    });
    const result = deduplicateDrafts([d1, d2]);

    expect(result).toHaveLength(2);
  });

  test("returns empty for empty input", () => {
    expect(deduplicateDrafts([])).toHaveLength(0);
  });
});
