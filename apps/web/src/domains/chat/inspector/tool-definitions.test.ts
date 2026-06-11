/**
 * Tests for the provider-agnostic tool-definition parser used by the
 * Prompt tab's structured tools UI. Covers the wire shapes the
 * assistant route emits for Anthropic and both OpenAI APIs, plus the
 * fallback (null) paths that keep the raw JSON card rendering.
 */

import { describe, expect, test } from "bun:test";

import { parseToolDefinitions } from "./tool-definitions";

describe("parseToolDefinitions", () => {
  test("parses Anthropic custom tools", () => {
    const tools = parseToolDefinitions({
      tools: [
        {
          name: "file_read",
          description: "Read a file from the workspace.",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    });

    expect(tools).toHaveLength(1);
    expect(tools![0]).toEqual({
      name: "file_read",
      type: null,
      description: "Read a file from the workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      extras: {},
    });
  });

  test("parses Anthropic server tools with extras and no schema", () => {
    const tools = parseToolDefinitions({
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 8 },
      ],
    });

    expect(tools).toHaveLength(1);
    expect(tools![0]).toEqual({
      name: "web_search",
      type: "web_search_20250305",
      description: null,
      inputSchema: null,
      extras: { max_uses: 8 },
    });
  });

  test("parses OpenAI Responses function tools", () => {
    const tools = parseToolDefinitions({
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Look up the weather.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    });

    expect(tools).toHaveLength(1);
    expect(tools![0]!.name).toBe("get_weather");
    expect(tools![0]!.type).toBeNull();
    expect(tools![0]!.inputSchema).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
    });
  });

  test("parses OpenAI Chat Completions nested function tools", () => {
    const tools = parseToolDefinitions([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Look up the weather.",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);

    expect(tools).toHaveLength(1);
    expect(tools![0]!.name).toBe("get_weather");
    expect(tools![0]!.description).toBe("Look up the weather.");
    expect(tools![0]!.inputSchema).toEqual({
      type: "object",
      properties: {},
    });
  });

  test("flattens Gemini functionDeclarations tool groups", () => {
    const tools = parseToolDefinitions({
      tools: [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Look up the weather.",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
            { name: "get_time" },
          ],
        },
      ],
    });

    expect(tools).toHaveLength(2);
    expect(tools![0]!.name).toBe("get_weather");
    expect(tools![0]!.inputSchema).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
    });
    expect(tools![1]!.name).toBe("get_time");
    expect(tools![1]!.inputSchema).toBeNull();
  });

  test("returns null for unrecognized payloads", () => {
    expect(parseToolDefinitions(null)).toBeNull();
    expect(parseToolDefinitions("tools")).toBeNull();
    expect(parseToolDefinitions({ tools: "nope" })).toBeNull();
    expect(parseToolDefinitions({ tools: [] })).toBeNull();
    expect(parseToolDefinitions({ tools: [{ description: "no name" }] })).toBeNull();
  });
});
