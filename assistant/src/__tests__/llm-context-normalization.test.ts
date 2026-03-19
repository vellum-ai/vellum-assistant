import { describe, expect, test } from "bun:test";

import { normalizeLlmContextPayloads } from "../runtime/routes/llm-context-normalization.js";

describe("normalizeLlmContextPayloads", () => {
  test("normalizes OpenAI request and response payloads", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_000,
      requestPayload: {
        model: "gpt-4.1",
        temperature: 0.2,
        tool_choice: "auto",
        messages: [
          { role: "system", content: "Be concise." },
          {
            role: "user",
            content: [
              { type: "text", text: "What's the weather in Boston?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              description: "Search the web",
              parameters: { type: "object" },
            },
          },
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Read forecast data",
              parameters: { type: "object" },
            },
          },
        ],
      },
      responsePayload: {
        model: "gpt-4.1-2026-03-01",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "I'll check the forecast.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({ query: "Boston weather" }),
                  },
                },
                {
                  id: "call_2",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: JSON.stringify({ city: "Boston" }),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 321,
          completion_tokens: 54,
        },
      },
    });

    expect(normalized.summary).toEqual({
      provider: "openai",
      model: "gpt-4.1-2026-03-01",
      inputTokens: 321,
      outputTokens: 54,
      stopReason: "tool_calls",
      requestMessageCount: 2,
      requestToolCount: 2,
      responseMessageCount: 1,
      responseToolCallCount: 2,
      responsePreview: "I'll check the forecast.",
      toolCallNames: ["web_search", "get_weather"],
    });
    expect(normalized.requestSections).toEqual([
      {
        kind: "system",
        label: "System prompt",
        role: "system",
        text: "Be concise.",
      },
      {
        kind: "message",
        label: "User message 2",
        role: "user",
        text: "What's the weather in Boston? [image]",
      },
      {
        kind: "tool_definitions",
        label: "Available tools",
        data: {
          tools: [
            {
              type: "function",
              function: {
                name: "web_search",
                description: "Search the web",
                parameters: { type: "object" },
              },
            },
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Read forecast data",
                parameters: { type: "object" },
              },
            },
          ],
        },
        language: "json",
      },
      {
        kind: "settings",
        label: "Request settings",
        data: {
          model: "gpt-4.1",
          temperature: 0.2,
          tool_choice: "auto",
        },
        language: "json",
      },
    ]);
    expect(normalized.responseSections).toEqual([
      {
        kind: "message",
        label: "Assistant response",
        role: "assistant",
        text: "I'll check the forecast.",
      },
      {
        kind: "function_call",
        label: "Response tool call 1",
        role: "assistant",
        toolName: "web_search",
        data: { query: "Boston weather" },
        text: '{"query":"Boston weather"}',
      },
      {
        kind: "function_call",
        label: "Response tool call 2",
        role: "assistant",
        toolName: "get_weather",
        data: { city: "Boston" },
        text: '{"city":"Boston"}',
      },
    ]);
  });

  test("normalizes Anthropic request and response payloads", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_001,
      requestPayload: {
        model: "claude-sonnet",
        max_tokens: 1_024,
        temperature: 0.1,
        tool_choice: { type: "auto" },
        system: [
          {
            type: "text",
            text: "Use tools when they improve accuracy.",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Find the latest changelog." }],
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Checking sources." },
              {
                type: "tool_use",
                id: "toolu_req_1",
                name: "web_search",
                input: { query: "vellum changelog" },
              },
            ],
          },
        ],
        tools: [
          {
            name: "web_search",
            description: "Search the web",
            input_schema: { type: "object" },
          },
        ],
      },
      responsePayload: {
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        usage: {
          input_tokens: 410,
          output_tokens: 73,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 80,
        },
        content: [
          { type: "text", text: "I found the changelog." },
          {
            type: "tool_use",
            id: "toolu_resp_1",
            name: "fetch_page",
            input: { url: "https://example.com/changelog" },
          },
        ],
      },
    });

    expect(normalized.summary).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 410,
      outputTokens: 73,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 80,
      stopReason: "tool_use",
      requestMessageCount: 2,
      requestToolCount: 1,
      responseMessageCount: 1,
      responseToolCallCount: 1,
      responsePreview: "I found the changelog.",
      toolCallNames: ["fetch_page"],
    });
    expect(normalized.requestSections).toEqual([
      {
        kind: "system",
        label: "System prompt",
        role: "system",
        text: "Use tools when they improve accuracy.",
      },
      {
        kind: "message",
        label: "User message 1",
        role: "user",
        text: "Find the latest changelog.",
      },
      {
        kind: "message",
        label: "Assistant message 2",
        role: "assistant",
        text: "Checking sources.",
      },
      {
        kind: "tool_use",
        label: "Assistant message 2 tool use",
        role: "assistant",
        toolName: "web_search",
        data: { query: "vellum changelog" },
        text: '{"query":"vellum changelog"}',
      },
      {
        kind: "tool_definitions",
        label: "Available tools",
        data: {
          tools: [
            {
              name: "web_search",
              description: "Search the web",
              input_schema: { type: "object" },
            },
          ],
        },
        language: "json",
      },
      {
        kind: "settings",
        label: "Request settings",
        data: {
          model: "claude-sonnet",
          max_tokens: 1_024,
          temperature: 0.1,
          tool_choice: { type: "auto" },
        },
        language: "json",
      },
    ]);
    expect(normalized.responseSections).toEqual([
      {
        kind: "message",
        label: "Assistant response",
        role: "assistant",
        text: "I found the changelog.",
      },
      {
        kind: "tool_use",
        label: "Assistant response tool use",
        role: "assistant",
        toolName: "fetch_page",
        data: { url: "https://example.com/changelog" },
        text: '{"url":"https://example.com/changelog"}',
      },
    ]);
  });

  test("normalizes Anthropic web_search_tool_result blocks", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_004,
      requestPayload: {
        model: "claude-sonnet",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "web_search_tool_result",
                tool_use_id: "stu_req_1",
                content: [
                  {
                    type: "web_search_result",
                    url: "https://example.com",
                    title: "Example result",
                    encrypted_content: "enc_123",
                  },
                ],
              },
            ],
          },
        ],
      },
      responsePayload: {
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 12,
          output_tokens: 8,
        },
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "stu_resp_1",
            content: [
              {
                type: "web_search_result",
                url: "https://example.org",
                title: "Another result",
                encrypted_content: "enc_456",
              },
            ],
          },
        ],
      },
    });

    expect(normalized.summary).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 12,
      outputTokens: 8,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: "end_turn",
      requestMessageCount: 1,
      requestToolCount: 0,
      responseMessageCount: 1,
      responseToolCallCount: undefined,
      responsePreview: "[Web search results]",
      toolCallNames: undefined,
    });
    expect(normalized.requestSections).toEqual([
      {
        kind: "message",
        label: "User message 1",
        role: "user",
        text: "[Web search results]",
      },
      {
        kind: "tool_result",
        label: "User message 1 tool result",
        role: "user",
        toolName: "stu_req_1",
        text: "[Web search results]",
      },
    ]);
    expect(normalized.responseSections).toEqual([
      {
        kind: "message",
        label: "Assistant response",
        role: "assistant",
        text: "[Web search results]",
      },
      {
        kind: "tool_result",
        label: "Assistant response tool result",
        role: "assistant",
        toolName: "stu_resp_1",
        text: "[Web search results]",
      },
    ]);
  });

  test("normalizes Gemini request and response payloads", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_002,
      requestPayload: {
        model: "gemini-3-flash",
        contents: [
          {
            role: "user",
            parts: [
              { text: "Summarize this file." },
              {
                functionResponse: {
                  id: "call_req_1",
                  name: "read_file",
                  response: { output: "Long file body" },
                },
              },
            ],
          },
          {
            role: "model",
            parts: [
              { text: "I can do that." },
              {
                functionCall: {
                  id: "call_req_2",
                  name: "search_notes",
                  args: { query: "summary" },
                },
              },
            ],
          },
        ],
        config: {
          systemInstruction: "Answer briefly.",
          temperature: 0.4,
          responseMimeType: "application/json",
          tools: [
            {
              functionDeclarations: [
                { name: "read_file", description: "Read a file" },
                { name: "search_notes", description: "Search notes" },
              ],
            },
          ],
        },
      },
      responsePayload: {
        model: "gemini-3-flash-001",
        text: "Here is the summary.",
        functionCalls: [
          {
            id: "call_resp_1",
            name: "save_note",
            args: { title: "brief" },
          },
        ],
        finishReason: "STOP",
        usageMetadata: {
          promptTokenCount: 200,
          candidatesTokenCount: 31,
        },
      },
    });

    expect(normalized.summary).toEqual({
      provider: "gemini",
      model: "gemini-3-flash-001",
      inputTokens: 200,
      outputTokens: 31,
      stopReason: "STOP",
      requestMessageCount: 2,
      requestToolCount: 2,
      responseMessageCount: 1,
      responseToolCallCount: 1,
      responsePreview: "Here is the summary.",
      toolCallNames: ["save_note"],
    });
    expect(normalized.requestSections).toEqual([
      {
        kind: "system",
        label: "System instruction",
        role: "system",
        text: "Answer briefly.",
      },
      {
        kind: "message",
        label: "User message 1",
        role: "user",
        text: "Summarize this file.",
      },
      {
        kind: "function_response",
        label: "User message 1 function response",
        role: "user",
        toolName: "read_file",
        data: { output: "Long file body" },
        text: '{"output":"Long file body"}',
      },
      {
        kind: "message",
        label: "Model message 2",
        role: "model",
        text: "I can do that.",
      },
      {
        kind: "function_call",
        label: "Model message 2 function call",
        role: "model",
        toolName: "search_notes",
        data: { query: "summary" },
        text: '{"query":"summary"}',
      },
      {
        kind: "tool_definitions",
        label: "Available tools",
        data: {
          tools: [
            {
              functionDeclarations: [
                { name: "read_file", description: "Read a file" },
                { name: "search_notes", description: "Search notes" },
              ],
            },
          ],
        },
        language: "json",
      },
      {
        kind: "settings",
        label: "Generation config",
        data: {
          model: "gemini-3-flash",
          config: {
            temperature: 0.4,
            responseMimeType: "application/json",
          },
        },
        language: "json",
      },
    ]);
    expect(normalized.responseSections).toEqual([
      {
        kind: "message",
        label: "Assistant response",
        role: "model",
        text: "Here is the summary.",
      },
      {
        kind: "function_call",
        label: "Response function call 1",
        role: "model",
        toolName: "save_note",
        data: { title: "brief" },
        text: '{"title":"brief"}',
      },
    ]);
  });

  test("omits normalized fields for malformed or unknown payloads", () => {
    const malformed = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_003,
      requestPayload: "not-json",
      responsePayload: { foo: "bar" },
    });

    expect(malformed.summary).toBeUndefined();
    expect(malformed.requestSections).toBeUndefined();
    expect(malformed.responseSections).toBeUndefined();
  });
});
