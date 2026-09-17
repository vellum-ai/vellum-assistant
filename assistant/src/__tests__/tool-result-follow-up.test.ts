import { describe, expect, test } from "bun:test";

import { buildToolResultFollowUp } from "../agent/tool-result-follow-up.js";
import type { ContentBlock, Message, TextContent } from "../providers/types.js";

const opener: Message = {
  role: "user",
  content: [{ type: "text", text: "Check both" }],
};

/** Assistant turn calling two client tools and a native web search together. */
const mixedTurn: Message = {
  role: "assistant",
  content: [
    { type: "tool_use", id: "tu_a", name: "web_fetch", input: {} },
    { type: "tool_use", id: "tu_b", name: "file_read", input: {} },
    {
      type: "server_tool_use",
      id: "srvtoolu_deferred",
      name: "web_search",
      input: { query: "news" },
    },
  ],
};

/** The same turn without the search: nothing is deferred. */
const clientOnlyTurn: Message = {
  role: "assistant",
  content: mixedTurn.content.filter((b) => b.type === "tool_use"),
};

const erroredResult: ContentBlock = {
  type: "tool_result",
  tool_use_id: "tu_a",
  content: "Error: HTTP 404",
  is_error: true,
};

const okResult: ContentBlock = {
  type: "tool_result",
  tool_use_id: "tu_b",
  content: "file contents",
  is_error: false,
};

const guidance: TextContent = {
  type: "text",
  text: "<system_notice>retry</system_notice>",
};

describe("buildToolResultFollowUp", () => {
  test("returns the results untouched when there is no guidance", () => {
    const results = [erroredResult, okResult];

    expect(buildToolResultFollowUp([opener, mixedTurn], results, [])).toBe(
      results,
    );
  });

  test("appends guidance as separate blocks when no server tool is deferred", () => {
    const followUp = buildToolResultFollowUp(
      [opener, clientOnlyTurn],
      [erroredResult, okResult],
      [guidance],
    );

    expect(followUp).toEqual([erroredResult, okResult, guidance]);
  });

  test("folds guidance into the errored tool_result when a server tool is deferred", () => {
    const followUp = buildToolResultFollowUp(
      [opener, mixedTurn],
      [erroredResult, okResult],
      [guidance],
    );

    expect(followUp.map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
    expect(followUp[0]).toEqual({
      ...erroredResult,
      content: `Error: HTTP 404\n\n${guidance.text}`,
    });
    expect(followUp[1]).toBe(okResult);
  });

  test("falls back to the last tool_result when none errored", () => {
    const followUp = buildToolResultFollowUp(
      [opener, mixedTurn],
      [okResult, { ...okResult, tool_use_id: "tu_a" }],
      [guidance],
    );

    expect(followUp.map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
    expect(followUp[0]).toBe(okResult);
    expect(followUp[1]).toMatchObject({
      tool_use_id: "tu_a",
      content: `file contents\n\n${guidance.text}`,
    });
  });
});
