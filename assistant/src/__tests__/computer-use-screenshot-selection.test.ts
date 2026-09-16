import { describe, expect, test } from "bun:test";

import { selectFinalComputerUseScreenshotCandidate } from "../daemon/conversation-agent-loop-handlers.js";
import type { ImageContent } from "../providers/types.js";

function screenshot(attachmentId: string): ImageContent {
  return {
    type: "image",
    source: {
      type: "workspace_ref",
      media_type: "image/png",
      attachmentId,
      sizeBytes: 10,
    },
  };
}

describe("final computer-use screenshot selection", () => {
  test("uses invocation order across interleaved results and skips screenshot-free calls", () => {
    const first = screenshot("first-image");
    const second = screenshot("second-image");
    const state = {
      computerUseToolUseIds: ["first", "second", "third"],
      computerUseToolNames: new Map([
        ["first", "computer_use_click"],
        ["second", "computer_use_scroll"],
        ["third", "computer_use_key"],
      ]),
      computerUseScreenshotBlocks: new Map([
        ["second", second],
        ["first", first],
      ]),
    };

    expect(selectFinalComputerUseScreenshotCandidate(state)).toEqual({
      toolName: "computer_use_scroll",
      block: second,
    });
  });

  test("fresh turn state has no screenshot candidate", () => {
    expect(
      selectFinalComputerUseScreenshotCandidate({
        computerUseToolUseIds: [],
        computerUseToolNames: new Map(),
        computerUseScreenshotBlocks: new Map(),
      }),
    ).toBeUndefined();
  });
});
