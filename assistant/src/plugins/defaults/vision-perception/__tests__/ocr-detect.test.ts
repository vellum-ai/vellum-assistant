import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../../../../providers/types.js";
import type { ToolContext } from "../../../../tools/types.js";

// `mock.module` is process-global, so all stubbing for the grounding tools lives
// in this one file (the test runner runs each file in its own process). We stub
// the provider resolution (spreading the real module so `extractAllText` keeps
// working) and the attachment store (fixture bytes + a configurable row). Each
// test sets `responseText` to whatever the model should "return".

let responseText = "";

const fakeProvider = {
  name: "mock-vision-provider",
  async sendMessage(_messages: Message[], _options: unknown) {
    return {
      content: [{ type: "text", text: responseText }],
      model: "mock-vision-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  },
};

const realPsm = await import("../../../../providers/provider-send-message.js");
mock.module("../../../../providers/provider-send-message.js", () => ({
  ...realPsm,
  getConfiguredProvider: async () => fakeProvider,
}));

// The execution guard checks the visionPerception call site resolves to an
// enabled vision-capable provider. Keep it available for these tests.
mock.module("../src/vision-capability.js", () => ({
  isVisionPerceptionProviderAvailable: () => true,
  VISION_CALL_SITE: "visionPerception",
}));

// A 4x2 PNG so `parseImageDimensions` returns a non-trivial size we can assert
// on. Small enough that `optimizeImageForTransport` leaves the bytes unchanged.
const PNG_4x2 = (() => {
  // PNG signature + IHDR(width=4,height=2). That header is all the dimension
  // parser reads, and the bytes are well under the optimize threshold, so this
  // truncated file flows through to the image block (and the parser) unchanged.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // length
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(4, 8); // width = 4
  ihdr.writeUInt32BE(2, 12); // height = 2
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // color type RGBA
  // CRC bytes left as zero — the dimension parser never validates the CRC.
  return Buffer.concat([sig, ihdr]);
})();

interface FakeRow {
  id: string;
  originalFilename: string;
  mimeType: string;
  kind: string;
}

let attachmentRows: Record<string, FakeRow> = {};
let attachmentBytes: Record<string, Buffer> = {};
// Maps attachment id -> the conversation it is linked to. The resolver enforces
// this access-control scope before reading any bytes.
let attachmentConversations: Record<string, string> = {};

mock.module("../../../../memory/attachments-store.js", () => ({
  getAttachmentById: (id: string) => attachmentRows[id] ?? null,
  getAttachmentContent: (id: string) => attachmentBytes[id] ?? null,
  getFilePathForAttachment: () => null,
  isAttachmentInConversation: (id: string, conversationId: string) =>
    attachmentConversations[id] === conversationId,
}));

const vlmOcrTool = (await import("../tools/vlm-ocr.js")).default;
const vlmDetectTool = (await import("../tools/vlm-detect.js")).default;

const ctx = { conversationId: "c1" } as unknown as ToolContext;

beforeEach(() => {
  responseText = "";
  attachmentRows = {
    "att-1": {
      id: "att-1",
      originalFilename: "photo.png",
      mimeType: "image/png",
      kind: "image",
    },
    "att-doc": {
      id: "att-doc",
      originalFilename: "notes.pdf",
      mimeType: "application/pdf",
      kind: "document",
    },
  };
  attachmentBytes = { "att-1": PNG_4x2, "att-doc": PNG_4x2 };
  // Both fixtures are linked to the current conversation ("c1") by default.
  attachmentConversations = { "att-1": "c1", "att-doc": "c1" };
});

describe("vlm_ocr tool", () => {
  test("returns the model's text as full_text with the echoed image_size", async () => {
    responseText = "Hello world\nLine two";
    const result = await vlmOcrTool.execute?.({ media_ref: "att-1" }, ctx);

    expect(result?.isError).toBe(false);
    const parsed = JSON.parse(result?.content ?? "");
    expect(parsed.full_text).toBe("Hello world\nLine two");
    expect(parsed.image_size).toEqual([4, 2]);
    expect(parsed.blocks).toBeUndefined();
  });

  test("parses positioned blocks and normalizes their boxes when layout=true", async () => {
    // Fractional coords (0..1) should scale up to the 0-1000 contract; an
    // already-0-1000 box should pass through clamped.
    responseText =
      '```json\n{"full_text": "ABC", "blocks": [' +
      '{"text": "A", "bbox": [0, 0, 0.5, 0.5]},' +
      '{"text": "BC", "bbox": [100, 200, 300, 400]}' +
      "]}\n```";
    const result = await vlmOcrTool.execute?.(
      { media_ref: "att-1", layout: true },
      ctx,
    );

    expect(result?.isError).toBe(false);
    const parsed = JSON.parse(result?.content ?? "");
    expect(parsed.full_text).toBe("ABC");
    expect(parsed.image_size).toEqual([4, 2]);
    expect(parsed.blocks).toEqual([
      { text: "A", bbox: [0, 0, 500, 500] },
      { text: "BC", bbox: [100, 200, 300, 400] },
    ]);
  });

  test("drops layout blocks with non-finite coords instead of fabricating a zero box", async () => {
    // null and empty-string coords must NOT coerce to a 0-size [0,0,0,0] box —
    // those blocks are dropped; the valid block is still returned.
    responseText =
      '```json\n{"full_text": "ABC", "blocks": [' +
      '{"text": "null-box", "bbox": [null, null, null, null]},' +
      '{"text": "empty-box", "bbox": ["", "", "", ""]},' +
      '{"text": "valid", "bbox": [100, 200, 300, 400]}' +
      "]}\n```";
    const result = await vlmOcrTool.execute?.(
      { media_ref: "att-1", layout: true },
      ctx,
    );

    expect(result?.isError).toBe(false);
    const parsed = JSON.parse(result?.content ?? "");
    expect(parsed.blocks).toEqual([
      { text: "valid", bbox: [100, 200, 300, 400] },
    ]);
  });

  test("layout=true with malformed model output degrades to isError (no throw)", async () => {
    responseText = "sorry, I cannot read that image";
    const result = await vlmOcrTool.execute?.(
      { media_ref: "att-1", layout: true },
      ctx,
    );

    expect(result?.isError).toBe(true);
  });

  test("returns isError (no throw) for a non-image attachment", async () => {
    responseText = "anything";
    const result = await vlmOcrTool.execute?.({ media_ref: "att-doc" }, ctx);

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("not an image");
  });
});

describe("vlm_detect tool", () => {
  test("parses detections, normalizes boxes to 0-1000, and echoes image_size", async () => {
    responseText =
      '{"detections": [' +
      '{"label": "cat", "bbox": [0.1, 0.2, 0.3, 0.4], "confidence": 0.9},' +
      '{"label": "dog", "bbox": [500, 600, 700, 800], "confidence": 0.5}' +
      "]}";
    const result = await vlmDetectTool.execute?.({ media_ref: "att-1" }, ctx);

    expect(result?.isError).toBe(false);
    const parsed = JSON.parse(result?.content ?? "");
    expect(parsed.image_size).toEqual([4, 2]);
    expect(parsed.detections).toEqual([
      { label: "cat", bbox: [100, 200, 300, 400], confidence: 0.9 },
      { label: "dog", bbox: [500, 600, 700, 800], confidence: 0.5 },
    ]);
  });

  test("accepts a fenced bare array of detections", async () => {
    responseText = '```json\n[{"label": "car", "bbox": [10, 20, 30, 40]}]\n```';
    const result = await vlmDetectTool.execute?.(
      { media_ref: "att-1", targets: ["car"] },
      ctx,
    );

    expect(result?.isError).toBe(false);
    const parsed = JSON.parse(result?.content ?? "");
    expect(parsed.detections).toEqual([
      { label: "car", bbox: [10, 20, 30, 40], confidence: null },
    ]);
  });

  test("drops detections with non-finite coords instead of returning zero boxes", async () => {
    // Placeholder/uncertain coords (null and empty strings) must NOT coerce to
    // a [0,0,0,0] box — those detections are dropped, while a valid detection
    // in the same response is still returned.
    responseText =
      '{"detections": [' +
      '{"label": "ghost", "bbox": [null, null, null, null], "confidence": 0.9},' +
      '{"label": "blank", "bbox": ["", "", "", ""], "confidence": 0.8},' +
      '{"label": "dog", "bbox": [500, 600, 700, 800], "confidence": 0.5}' +
      "]}";
    const result = await vlmDetectTool.execute?.({ media_ref: "att-1" }, ctx);

    expect(result?.isError).toBe(false);
    const parsed = JSON.parse(result?.content ?? "");
    expect(parsed.detections).toEqual([
      { label: "dog", bbox: [500, 600, 700, 800], confidence: 0.5 },
    ]);
  });

  test("malformed model output degrades to isError (no throw)", async () => {
    responseText = "I found a cat near the top-left.";
    const result = await vlmDetectTool.execute?.({ media_ref: "att-1" }, ctx);

    expect(result?.isError).toBe(true);
  });

  test("returns isError (no throw) for a missing media_ref", async () => {
    responseText = '{"detections": []}';
    const result = await vlmDetectTool.execute?.(
      { media_ref: "does-not-exist" },
      ctx,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("No attachment found");
  });
});

describe("conversation isolation (cross-conversation media_ref)", () => {
  test("vlm_ocr and vlm_detect reject an id linked to a DIFFERENT conversation", async () => {
    // The attachment row + bytes exist, but the link points at another
    // conversation. A model that supplies this crafted id must get an error.
    attachmentConversations = { "att-1": "other-conv" };
    responseText = '{"detections": []}';

    const ocr = await vlmOcrTool.execute?.({ media_ref: "att-1" }, ctx);
    expect(ocr?.isError).toBe(true);
    expect(ocr?.content).toContain("No attachment found");

    const detect = await vlmDetectTool.execute?.({ media_ref: "att-1" }, ctx);
    expect(detect?.isError).toBe(true);
    expect(detect?.content).toContain("No attachment found");
  });
});
