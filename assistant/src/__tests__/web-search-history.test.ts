import { describe, expect, test } from "bun:test";

import { stripHistoricalWebSearchResults } from "../daemon/web-search-history.js";
import type { Message } from "../providers/types.js";

describe("stripHistoricalWebSearchResults", () => {
  test("no-op when there are no web_search_tool_result blocks", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    const { messages: result, stats } = stripHistoricalWebSearchResults(
      messages,
    );

    expect(result).toEqual(messages);
    expect(stats.blocksStripped).toBe(0);
    expect(stats.serverToolUsesDropped).toBe(0);
    expect(stats.messagesModified).toBe(0);
  });

  test(
    "replaces historical web_search_tool_result with text summary including title+url",
    () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Search cats" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me look" },
            {
              type: "server_tool_use",
              id: "stu_1",
              name: "web_search",
              input: { query: "cats" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "stu_1",
              content: [
                {
                  type: "web_search_result",
                  url: "https://cats.com",
                  title: "Cats!",
                  encrypted_content: "expired_token_1",
                },
                {
                  type: "web_search_result",
                  url: "https://felines.org",
                  title: "Feline facts",
                  encrypted_content: "expired_token_2",
                },
              ],
            },
            { type: "text", text: "Here's what I found." },
          ],
        },
      ];

      const { messages: result, stats } = stripHistoricalWebSearchResults(
        messages,
      );

      expect(stats.blocksStripped).toBe(1);
      expect(stats.serverToolUsesDropped).toBe(1);
      expect(stats.messagesModified).toBe(1);

      const assistantMsg = result[1];
      const types = assistantMsg.content.map((b) => b.type);
      expect(types).toEqual(["text", "text", "text"]);

      const summary = assistantMsg.content[1];
      expect(summary.type).toBe("text");
      if (summary.type === "text") {
        expect(summary.text).toContain("cats");
        expect(summary.text).toContain("Cats!");
        expect(summary.text).toContain("https://cats.com");
        expect(summary.text).toContain("Feline facts");
        expect(summary.text).toContain("https://felines.org");
        expect(summary.text).not.toContain("expired_token_1");
      }
    },
  );

  test("drops server_tool_use paired with converted results", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_A",
            name: "web_search",
            input: { query: "alpha" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_A",
            content: [
              {
                type: "web_search_result",
                url: "https://a.example",
                title: "A",
                encrypted_content: "tok_A",
              },
            ],
          },
        ],
      },
    ];

    const { messages: result, stats } = stripHistoricalWebSearchResults(
      messages,
    );

    expect(stats.blocksStripped).toBe(1);
    expect(stats.serverToolUsesDropped).toBe(1);
    expect(result[0].content).toHaveLength(1);
    expect(result[0].content[0].type).toBe("text");
  });

  test("preserves unrelated server_tool_use blocks when other searches stripped", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_A",
            name: "web_search",
            input: { query: "alpha" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_A",
            content: [
              {
                type: "web_search_result",
                url: "https://a.example",
                title: "A",
                encrypted_content: "tok_A",
              },
            ],
          },
          {
            type: "server_tool_use",
            id: "stu_B",
            name: "web_search",
            input: { query: "beta" },
          },
        ],
      },
    ];

    const { messages: result, stats } = stripHistoricalWebSearchResults(
      messages,
    );

    expect(stats.serverToolUsesDropped).toBe(1);
    const types = result[0].content.map((b) => b.type);
    expect(types).toEqual(["text", "server_tool_use"]);
    const preserved = result[0].content[1];
    expect(preserved.type).toBe("server_tool_use");
    if (preserved.type === "server_tool_use") {
      expect(preserved.id).toBe("stu_B");
    }
  });

  test("handles web_search_tool_result with error content gracefully", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_1",
            name: "web_search",
            input: { query: "x" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_1",
            content: {
              type: "web_search_tool_result_error",
              error_code: "unavailable",
            },
          },
        ],
      },
    ];

    const { messages: result, stats } = stripHistoricalWebSearchResults(
      messages,
    );

    expect(stats.blocksStripped).toBe(1);
    expect(result[0].content).toHaveLength(1);
    const summary = result[0].content[0];
    expect(summary.type).toBe("text");
    if (summary.type === "text") {
      expect(summary.text).toContain("unavailable");
    }
  });

  test("falls back when query cannot be found", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_missing",
            content: [
              {
                type: "web_search_result",
                url: "https://x.example",
                title: "X",
                encrypted_content: "tok",
              },
            ],
          },
        ],
      },
    ];

    const { messages: result, stats } = stripHistoricalWebSearchResults(
      messages,
    );

    expect(stats.blocksStripped).toBe(1);
    expect(stats.serverToolUsesDropped).toBe(0);
    const summary = result[0].content[0];
    expect(summary.type).toBe("text");
    if (summary.type === "text") {
      expect(summary.text).toContain("Prior web_search results");
      expect(summary.text).toContain("https://x.example");
    }
  });

  test("handles multiple searches in one assistant message", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_1",
            name: "web_search",
            input: { query: "first" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_1",
            content: [
              {
                type: "web_search_result",
                url: "https://first.example",
                title: "First",
                encrypted_content: "tok_1",
              },
            ],
          },
          { type: "text", text: "interlude" },
          {
            type: "server_tool_use",
            id: "stu_2",
            name: "web_search",
            input: { query: "second" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_2",
            content: [
              {
                type: "web_search_result",
                url: "https://second.example",
                title: "Second",
                encrypted_content: "tok_2",
              },
            ],
          },
        ],
      },
    ];

    const { messages: result, stats } = stripHistoricalWebSearchResults(
      messages,
    );

    expect(stats.blocksStripped).toBe(2);
    expect(stats.serverToolUsesDropped).toBe(2);
    expect(stats.messagesModified).toBe(1);

    const types = result[0].content.map((b) => b.type);
    expect(types).toEqual(["text", "text", "text"]);

    const first = result[0].content[0];
    const second = result[0].content[2];
    if (first.type === "text") expect(first.text).toContain("first");
    if (second.type === "text") expect(second.text).toContain("second");
  });

  test("does not mutate the input messages array", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "stu_1",
            name: "web_search",
            input: { query: "q" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_1",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "E",
                encrypted_content: "tok",
              },
            ],
          },
        ],
      },
    ];
    const beforeTypes = messages[0].content.map((b) => b.type);

    stripHistoricalWebSearchResults(messages);

    const afterTypes = messages[0].content.map((b) => b.type);
    expect(afterTypes).toEqual(beforeTypes);
  });
});
