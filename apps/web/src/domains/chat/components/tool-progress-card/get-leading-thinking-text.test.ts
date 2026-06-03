import { describe, expect, test } from "bun:test";

import { getLeadingThinkingText } from "@/domains/chat/components/tool-progress-card/get-leading-thinking-text";
import { groupContentBlocks } from "@/domains/chat/utils/display-content-blocks";
import type { DisplayContentBlock } from "@/domains/chat/types/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

function toolCall(id: string, toolName = "do_thing"): ChatMessageToolCall {
  return { id, toolName, status: "completed", input: {} };
}

function surface(surfaceId: string) {
  return { surfaceId, surfaceType: "card", data: {} } as const;
}

describe("getLeadingThinkingText", () => {
  test("returns the trimmed text when a text group sits directly before the tool group", () => {
    /**
     * Mirrors the common streaming case: the assistant emits a short
     * text delta announcing its intent ("Let me check the docs…") and
     * then opens a tool call. The unified progress card should surface
     * that preamble as the "thinking" step.
     */
    // GIVEN blocks [text, tool_use] grouped into [text, toolCalls]
    const groups = groupContentBlocks([
      { type: "text", text: "  Looking up the docs.  " },
      { type: "tool_use", toolCall: toolCall("tc-1") },
    ]);

    // WHEN we ask for the thinking text preceding the tool group at index 1
    const result = getLeadingThinkingText(groups, 1);

    // THEN we get the trimmed text back
    expect(result).toBe("Looking up the docs.");
  });

  test("returns null when a non-text group precedes the tool group", () => {
    /**
     * Two tool-call groups separated by an inline surface must not
     * borrow text from earlier in the message — we only look one step
     * back, and the preceding group here is a surface.
     */
    // GIVEN [text, tool_use, surface, tool_use] grouped into
    // [text, toolCalls, surface, toolCalls]
    const groups = groupContentBlocks([
      { type: "text", text: "Earlier preamble." },
      { type: "tool_use", toolCall: toolCall("tc-1") },
      { type: "surface", surface: surface("s-1") },
      { type: "tool_use", toolCall: toolCall("tc-2") },
    ]);

    // WHEN we ask for the thinking text preceding the second tool group (index 3)
    const result = getLeadingThinkingText(groups, 3);

    // THEN we get null — the preceding group is a surface, not text
    expect(result).toBeNull();
  });

  test("returns null when the tool group is the first group", () => {
    /**
     * If the assistant opens with a tool call before emitting any
     * text, there is nothing to surface as "thinking".
     */
    // GIVEN a message that opens with a tool call
    const groups = groupContentBlocks([
      { type: "tool_use", toolCall: toolCall("tc-1") },
    ]);

    // WHEN we ask for the thinking text at index 0
    const result = getLeadingThinkingText(groups, 0);

    // THEN we get null
    expect(result).toBeNull();
  });

  test("returns null when the preceding text is empty after trimming", () => {
    /**
     * Streaming sometimes flushes an empty text block right before a
     * tool call (e.g. whitespace-only deltas). We treat those as "no
     * preamble" so the carousel doesn't render a blank step.
     */
    // GIVEN a text block containing only whitespace
    const groups = groupContentBlocks([
      { type: "text", text: "   \n  " },
      { type: "tool_use", toolCall: toolCall("tc-1") },
    ]);

    // WHEN we ask for the thinking text preceding the tool group
    const result = getLeadingThinkingText(groups, 1);

    // THEN we get null — the trimmed text is empty
    expect(result).toBeNull();
  });

  test("truncates text longer than 160 characters", () => {
    /**
     * The thinking step is a single-line preview, so very long
     * preambles must be clipped to keep the card compact.
     */
    // GIVEN a long assistant preamble
    const groups = groupContentBlocks([
      { type: "text", text: "a".repeat(200) },
      { type: "tool_use", toolCall: toolCall("tc-1") },
    ]);

    // WHEN we ask for the thinking text
    const result = getLeadingThinkingText(groups, 1);

    // THEN it is truncated to 160 characters
    expect(result).toBe("a".repeat(160));
  });

  test("aligns the index with the merged tool group", () => {
    /**
     * `groupContentBlocks` collapses adjacent tool_use blocks into one
     * group, so a [text, tool_use, tool_use] body becomes
     * [text, toolCalls] and the tool group lands at index 1.
     */
    // GIVEN [text, tool_use, tool_use] which collapses to [text, toolCalls]
    const blocks: DisplayContentBlock[] = [
      { type: "text", text: "Thinking step." },
      { type: "tool_use", toolCall: toolCall("tc-1") },
      { type: "tool_use", toolCall: toolCall("tc-2") },
    ];
    const groups = groupContentBlocks(blocks);

    // WHEN we ask for the thinking text preceding the merged tool group at index 1
    const result = getLeadingThinkingText(groups, 1);

    // THEN we get the preceding text back
    expect(result).toBe("Thinking step.");
  });
});
