import { describe, expect, test } from "bun:test";

import type { RuntimeMessage } from "@/domains/chat/api/messages";
import {
  mapRuntimeToDisplayMessage,
  prepareServerMessage,
  runtimeMessagePlainText,
} from "@/domains/chat/utils/map-runtime-message";

import {
  makeServerMessage,
  messageText,
  wireTextBody,
} from "@/domains/chat/utils/message-test-helpers";
function makeMessage(overrides: Partial<RuntimeMessage>): RuntimeMessage {
  return makeServerMessage({ id: "msg-1", role: "assistant", ...overrides });
}

describe("prepareServerMessage", () => {
  test("returns unchanged segments when no attachment markers appear", () => {
    const m = makeMessage({
      textSegments: ["hello world"],
      contentOrder: ["text:0"],
    });

    const prepared = prepareServerMessage(m);

    expect(runtimeMessagePlainText(m)).toBe("hello world");
    expect(prepared.normalizedSegments).toEqual([
      { type: "text", content: "hello world" },
    ]);
  });

  test("strips attachment summary appended to the only segment", () => {
    const m = makeMessage({
      textSegments: [
        "here you go\n[File attachment] file.pdf, type=application/pdf",
      ],
      contentOrder: ["text:0"],
    });

    const prepared = prepareServerMessage(m);

    expect(runtimeMessagePlainText(m)).toBe("here you go");
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
      textSegments: [
        "preamble",
        "after-tool\n[File attachment] file.pdf, type=application/pdf",
      ],
      contentOrder: ["text:0", "tool:0", "text:1"],
    });

    const prepared = prepareServerMessage(m);

    expect(runtimeMessagePlainText(m)).toBe("preamble after-tool");
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
      textSegments: [
        "Connected as user@example.com",
        "Here is the analysis.\n[File attachment] data.csv, type=text/csv",
      ],
      contentOrder: ["text:0", "surface:0", "text:1"],
    });

    const prepared = prepareServerMessage(m);

    expect(prepared.normalizedSegments).toEqual([
      { type: "text", content: "Connected as user@example.com" },
      { type: "text", content: "Here is the analysis." },
    ]);
    expect(runtimeMessagePlainText(m)).toBe(
      "Connected as user@example.com Here is the analysis.",
    );
  });

  test("collapses an attachment-only trailing segment to an empty string", () => {
    // When the daemon adds attachmentParts via `ensureSegment()` to a brand
    // new segment (rather than appending to an existing one), the segment's
    // entire content is the `[File attachment]` summary block.
    const m = makeMessage({
      textSegments: [
        "look at this",
        "[File attachment] x.pdf, type=application/pdf",
      ],
      contentOrder: ["text:0", "text:1"],
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
      textSegments: [
        "intro",
        "tail\n[File attachment] sheet.csv, type=text/csv, size=1.0 KB",
      ],
      contentOrder: ["text:0", "tool:0", "text:1"],
    });

    const display = mapRuntimeToDisplayMessage(m);

    expect(messageText(display)).toBe("intro tail");
    expect(display.textSegments).toEqual([
      { type: "text", content: "intro" },
      { type: "text", content: "tail" },
    ]);
    expect(display.attachments?.[0]).toMatchObject({
      filename: "sheet.csv",
      mimeType: "text/csv",
    });
  });

  test("carries server thinkingSegments and contentOrder onto the display message", () => {
    // GIVEN a persisted assistant message whose reasoning is reconstructed
    // from history as `thinkingSegments` + a `thinking` content-order entry
    const m = makeMessage({
      id: "msg-think",
      role: "assistant",
      textSegments: ["the answer"],
      thinkingSegments: ["let me reason", "and conclude"],
      contentOrder: ["thinking:0", "thinking:1", "text:0"],
    });

    // WHEN it is mapped into a display message
    const display = mapRuntimeToDisplayMessage(m);

    // THEN the reasoning and its ordering survive so the transcript can
    // render the thinking blocks in place
    expect(display.thinkingSegments).toEqual(["let me reason", "and conclude"]);
    expect(display.contentOrder).toEqual([
      { type: "thinking", id: "0" },
      { type: "thinking", id: "1" },
      { type: "text", id: "0" },
    ]);
  });

  test("preserves Slack message metadata alongside mapped message fields", () => {
    const m = makeMessage({
      id: "msg-slack",
      role: "user",
      ...wireTextBody("Slack reply"),
      slackMessage: {
        channelId: "C123ABCDEF",
        channelName: "triage",
        channelTs: "1710000000.000200",
        threadTs: "1710000000.000100",
        sender: {
          displayName: "Ada Lovelace",
          externalUserId: "U123",
        },
        messageLink: {
          appUrl:
            "slack://channel?team=T123&id=C123ABCDEF&message=1710000000.000200",
          webUrl:
            "https://example.slack.com/archives/C123ABCDEF/p1710000000000200",
        },
        threadLink: {
          appUrl:
            "slack://channel?team=T123&id=C123ABCDEF&message=1710000000.000100",
          webUrl:
            "https://example.slack.com/archives/C123ABCDEF/p1710000000000100",
        },
      },
      timestamp: "2026-05-15T12:34:56.000Z",
    });

    const display = mapRuntimeToDisplayMessage(m);

    expect(display).toMatchObject({
      id: "msg-slack",
      role: "user",
      textSegments: [{ type: "text", content: "Slack reply" }],
      slackMessage: m.slackMessage,
      timestamp: Date.parse("2026-05-15T12:34:56.000Z"),
    });
  });
});
