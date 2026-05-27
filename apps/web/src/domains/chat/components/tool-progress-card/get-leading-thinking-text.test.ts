import { describe, expect, test } from "bun:test";

import { getLeadingThinkingText } from "@/domains/chat/components/tool-progress-card/get-leading-thinking-text";
import type { DisplayMessage } from "@/domains/chat/types/types";

function makeMessage(
  contentOrder: Array<{ type: string; id: string }>,
  textSegments: Array<{ type: string; content: string }> = [],
): DisplayMessage {
  return {
    id: "stable-1",
    role: "assistant",
    content: "",
    contentOrder,
    textSegments,
  };
}

describe("getLeadingThinkingText", () => {
  test("returns the trimmed text when a text group sits directly before the tool group", () => {
    /**
     * Mirrors the common streaming case: the assistant emits a short
     * text delta announcing its intent ("Let me check the docs…") and
     * then opens a tool call. The unified progress card should surface
     * that preamble as the "thinking" step.
     */
    // GIVEN a message whose contentOrder is [text, toolCall]
    const message = makeMessage(
      [
        { type: "text", id: "0" },
        { type: "toolCall", id: "tc-1" },
      ],
      [{ type: "text", content: "  Looking up the docs.  " }],
    );

    // WHEN we ask for the thinking text preceding the tool group at index 1
    const result = getLeadingThinkingText(message, 1);

    // THEN we get the trimmed text back
    expect(result).toBe("Looking up the docs.");
  });

  test("returns null when another tool group precedes the tool group", () => {
    /**
     * Two consecutive tool-call groups (separated by something that
     * is itself not assistant text, e.g. an inline surface) must not
     * borrow text from earlier in the message — we only look one
     * step back.
     */
    // GIVEN [text, toolCall, surface, toolCall] — the second tool
    // group is preceded by a surface group, not by text
    const message = makeMessage(
      [
        { type: "text", id: "0" },
        { type: "toolCall", id: "tc-1" },
        { type: "surface", id: "s-1" },
        { type: "toolCall", id: "tc-2" },
      ],
      [{ type: "text", content: "Earlier preamble." }],
    );

    // WHEN we ask for the thinking text preceding the second tool group (index 3)
    const result = getLeadingThinkingText(message, 3);

    // THEN we get null — the preceding group is a surface, not text
    expect(result).toBeNull();
  });

  test("returns null when the tool group is the first group", () => {
    /**
     * If the assistant opens with a tool call before emitting any
     * text, there is nothing to surface as "thinking".
     */
    // GIVEN a message that opens with a tool call
    const message = makeMessage([{ type: "toolCall", id: "tc-1" }]);

    // WHEN we ask for the thinking text at index 0
    const result = getLeadingThinkingText(message, 0);

    // THEN we get null
    expect(result).toBeNull();
  });

  test("returns null when the preceding text segment is empty after trimming", () => {
    /**
     * Streaming sometimes flushes an empty text segment right before
     * a tool call (e.g. whitespace-only deltas). We treat those as
     * "no preamble" so the carousel doesn't render a blank step.
     */
    // GIVEN a text segment containing only whitespace
    const message = makeMessage(
      [
        { type: "text", id: "0" },
        { type: "toolCall", id: "tc-1" },
      ],
      [{ type: "text", content: "   \n  " }],
    );

    // WHEN we ask for the thinking text preceding the tool group
    const result = getLeadingThinkingText(message, 1);

    // THEN we get null — the trimmed text is empty
    expect(result).toBeNull();
  });

  test("truncates text longer than 160 characters", () => {
    /**
     * The thinking step is a single-line preview, so very long
     * preambles must be clipped to keep the card compact.
     */
    // GIVEN a long assistant preamble
    const longText = "a".repeat(200);
    const message = makeMessage(
      [
        { type: "text", id: "0" },
        { type: "toolCall", id: "tc-1" },
      ],
      [{ type: "text", content: longText }],
    );

    // WHEN we ask for the thinking text
    const result = getLeadingThinkingText(message, 1);

    // THEN it is truncated to 160 characters
    expect(result).toBe("a".repeat(160));
  });

  test("merges consecutive tool entries into one group when computing the index", () => {
    /**
     * The renderer collapses adjacent toolCall/tool entries into one
     * group. The util mirrors that so callers can pass the same
     * `toolGroupIndex` the renderer computes — here the second tool
     * group is at index 1, not 2.
     */
    // GIVEN [text, toolCall, toolCall] which collapses to [text, toolCalls]
    const message = makeMessage(
      [
        { type: "text", id: "0" },
        { type: "toolCall", id: "tc-1" },
        { type: "toolCall", id: "tc-2" },
      ],
      [{ type: "text", content: "Thinking step." }],
    );

    // WHEN we ask for the thinking text preceding the merged tool group at index 1
    const result = getLeadingThinkingText(message, 1);

    // THEN we get the preceding text back
    expect(result).toBe("Thinking step.");
  });
});
