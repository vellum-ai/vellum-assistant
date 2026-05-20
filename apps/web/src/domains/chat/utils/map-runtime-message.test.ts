import { describe, expect, test } from "bun:test";

import type { RuntimeMessage } from "@/domains/chat/api/messages.js";
import {
  mapRuntimeToDisplayMessage,
  prepareServerMessage,
} from "@/domains/chat/utils/map-runtime-message.js";

function makeMessage(overrides: Partial<RuntimeMessage>): RuntimeMessage {
  return {
    id: "msg-1",
    role: "assistant",
    content: "",
    ...overrides,
  };
}

describe("prepareServerMessage", () => {
  test("returns unchanged segments when no attachment markers appear", () => {
    const m = makeMessage({
      content: "hello world",
      textSegments: [{ type: "text", content: "hello world" }],
      contentOrder: [{ type: "text", id: "0" }],
    });

    const prepared = prepareServerMessage(m);

    expect(prepared.cleanedContent).toBe("hello world");
    expect(prepared.normalizedSegments).toEqual([
      { type: "text", content: "hello world" },
    ]);
  });

  test("strips attachment summary appended to the only segment", () => {
    const m = makeMessage({
      content: "here you go\n[File attachment] file.pdf, type=application/pdf",
      textSegments: [
        {
          type: "text",
          content:
            "here you go\n[File attachment] file.pdf, type=application/pdf",
        },
      ],
      contentOrder: [{ type: "text", id: "0" }],
    });

    const prepared = prepareServerMessage(m);

    expect(prepared.cleanedContent).toBe("here you go");
    expect(prepared.normalizedSegments).toEqual([
      { type: "text", content: "here you go" },
    ]);
  });

  test("strips attachment summary from the trailing segment for interleaved messages (LUM-1527)", () => {
    // Mirrors the daemon shape produced by `renderHistoryContent` when the
    // assistant emits text -> tool_use -> text -> file in a single message.
    // The `[File attachment]` summary is appended to the LAST text segment,
    // which is NOT segment[0]. Patching only segment[0] would leave the raw
    // line visible in segment[1].
    const m = makeMessage({
      content:
        "preamble after-tool\n[File attachment] file.pdf, type=application/pdf",
      textSegments: [
        { type: "text", content: "preamble" },
        {
          type: "text",
          content:
            "after-tool\n[File attachment] file.pdf, type=application/pdf",
        },
      ],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "tool", id: "0" },
        { type: "text", id: "1" },
      ],
    });

    const prepared = prepareServerMessage(m);

    expect(prepared.cleanedContent).toBe("preamble after-tool");
    expect(prepared.normalizedSegments).toEqual([
      { type: "text", content: "preamble" },
      { type: "text", content: "after-tool" },
    ]);
  });

  test("strips attachment summary when it lands in segment[1] but segment[0] is unrelated", () => {
    // Same surface-then-text shape that caused the Marina report:
    // segment[0] is short OAuth-completion text, a `ui_surface` block sits
    // between, then a longer narrative ends with the attachment summary.
    const m = makeMessage({
      content:
        "Connected as user@example.com\nHere is the analysis.\n[File attachment] data.csv, type=text/csv",
      textSegments: [
        { type: "text", content: "Connected as user@example.com" },
        {
          type: "text",
          content:
            "Here is the analysis.\n[File attachment] data.csv, type=text/csv",
        },
      ],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "surface", id: "0" },
        { type: "text", id: "1" },
      ],
    });

    const prepared = prepareServerMessage(m);

    expect(prepared.normalizedSegments).toEqual([
      { type: "text", content: "Connected as user@example.com" },
      { type: "text", content: "Here is the analysis." },
    ]);
    expect(prepared.cleanedContent).toBe(
      "Connected as user@example.com\nHere is the analysis.",
    );
  });

  test("collapses an attachment-only trailing segment to an empty string", () => {
    // When the daemon adds attachmentParts via `ensureSegment()` to a brand
    // new segment (rather than appending to an existing one), the segment's
    // entire content is the `[File attachment]` summary block.
    const m = makeMessage({
      content: "look at this\n[File attachment] x.pdf, type=application/pdf",
      textSegments: [
        { type: "text", content: "look at this" },
        {
          type: "text",
          content: "[File attachment] x.pdf, type=application/pdf",
        },
      ],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "text", id: "1" },
      ],
    });

    const prepared = prepareServerMessage(m);

    expect(prepared.normalizedSegments).toEqual([
      { type: "text", content: "look at this" },
      { type: "text", content: "" },
    ]);
  });

});

describe("mapRuntimeToDisplayMessage", () => {
  test("produces clean segments end-to-end for interleaved file attachments", () => {
    const m = makeMessage({
      id: "msg-2",
      role: "assistant",
      content:
        "intro tail\n[File attachment] sheet.csv, type=text/csv, size=1.0 KB",
      textSegments: [
        { type: "text", content: "intro" },
        {
          type: "text",
          content:
            "tail\n[File attachment] sheet.csv, type=text/csv, size=1.0 KB",
        },
      ],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "tool", id: "0" },
        { type: "text", id: "1" },
      ],
    });

    const display = mapRuntimeToDisplayMessage(m);

    expect(display.content).toBe("intro tail");
    expect(display.textSegments).toEqual([
      { type: "text", content: "intro" },
      { type: "text", content: "tail" },
    ]);
    expect(display.attachments?.[0]).toMatchObject({
      filename: "sheet.csv",
      mimeType: "text/csv",
    });
  });
});
