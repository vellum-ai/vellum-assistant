import { describe, expect, test } from "bun:test";

import { analyzeServerToolPairing } from "../providers/server-tool-pairing.js";
import type { ContentBlock, Message } from "../providers/types.js";

const DEFERRED_ID = "srvtoolu_deferred";

const opener: Message = {
  role: "user",
  content: [{ type: "text", text: "Check both" }],
};

/** Assistant turn calling a client tool and a native web search together. */
const mixedTail: Message = {
  role: "assistant",
  content: [
    { type: "tool_use", id: "tu_a", name: "web_fetch", input: {} },
    {
      type: "server_tool_use",
      id: DEFERRED_ID,
      name: "web_search",
      input: { query: "news" },
    },
  ],
};

const clientResult: ContentBlock = {
  type: "tool_result",
  tool_use_id: "tu_a",
  content: "Error: HTTP 404",
  is_error: true,
};

const guidance: ContentBlock = {
  type: "text",
  text: "<system_notice>retry</system_notice>",
};

describe("analyzeServerToolPairing", () => {
  test("an unanswered use with nothing after it is deferred", () => {
    const pairing = analyzeServerToolPairing([opener, mixedTail]);

    expect(pairing.deferredUseIds).toEqual(new Set([DEFERRED_ID]));
    expect(pairing.resolvedPairIds.size).toBe(0);
  });

  test("an unanswered use answered by tool_result blocks alone is deferred", () => {
    const pairing = analyzeServerToolPairing([
      opener,
      mixedTail,
      { role: "user", content: [clientResult] },
    ]);

    expect(pairing.deferredUseIds).toEqual(new Set([DEFERRED_ID]));
  });

  test("guidance text after the tool_result makes the use an orphan, not a deferral", () => {
    // The trailing text closes the assistant turn on the provider side, which
    // then rejects the unanswered use as unpaired; the repair passes stamp a
    // synthetic result instead of preserving it.
    const pairing = analyzeServerToolPairing([
      opener,
      mixedTail,
      { role: "user", content: [clientResult, guidance] },
    ]);

    expect(pairing.deferredUseIds.size).toBe(0);
    expect(pairing.resolvedPairIds.size).toBe(0);
  });

  test("a user text message after the tool_result message makes the use an orphan", () => {
    const pairing = analyzeServerToolPairing([
      opener,
      mixedTail,
      { role: "user", content: [clientResult] },
      { role: "user", content: [{ type: "text", text: "also do this" }] },
    ]);

    expect(pairing.deferredUseIds.size).toBe(0);
  });

  test("a use answered in its own message is resolved and never deferred", () => {
    const pairing = analyzeServerToolPairing([
      opener,
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_done",
            name: "web_search",
            input: { query: "news" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_done",
            content: [],
          },
        ],
      },
      { role: "user", content: [guidance] },
    ]);

    expect(pairing.resolvedPairIds).toEqual(new Set(["srvtoolu_done"]));
    expect(pairing.deferredUseIds.size).toBe(0);
  });
});
