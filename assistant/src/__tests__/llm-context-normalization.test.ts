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
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,abc" },
              },
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
        text: "What's the weather in Boston?\n\n[image]",
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
                type: "thinking",
                thinking: "I should search the changelog.",
              },
              {
                type: "redacted_thinking",
                signature: "sig_req_1",
              },
              {
                type: "server_tool_use",
                id: "srvtoolu_req_1",
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
            type: "thinking",
            thinking: "I should fetch the page.",
          },
          {
            type: "redacted_thinking",
            signature: "sig_resp_1",
          },
          {
            type: "server_tool_use",
            id: "srvtoolu_resp_1",
            name: "web_search",
            input: { query: "vellum changelog" },
          },
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
      responseToolCallCount: 2,
      responsePreview: "I found the changelog.",
      toolCallNames: ["web_search", "fetch_page"],
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
        kind: "reasoning",
        label: "Assistant message 2 reasoning",
        role: "assistant",
        text: "I should search the changelog.",
      },
      {
        kind: "reasoning",
        label: "Assistant message 2 reasoning",
        role: "assistant",
        text: "[redacted thinking]",
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
        kind: "reasoning",
        label: "Assistant response reasoning",
        role: "assistant",
        text: "I should fetch the page.",
      },
      {
        kind: "reasoning",
        label: "Assistant response reasoning",
        role: "assistant",
        text: "[redacted thinking]",
      },
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
        toolName: "web_search",
        data: { query: "vellum changelog" },
        text: '{"query":"vellum changelog"}',
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

  test("keeps Anthropic reasoning separate from response preview text", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_008,
      requestPayload: {
        model: "claude-sonnet",
        messages: [{ role: "user", content: "Give me the answer." }],
      },
      responsePayload: {
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 21,
          output_tokens: 10,
        },
        content: [
          {
            type: "thinking",
            thinking: "I have enough context now.",
          },
          {
            type: "redacted_thinking",
            signature: "sig_resp_2",
          },
          { type: "text", text: "The answer is 42." },
        ],
      },
    });

    expect(normalized.summary).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 21,
      outputTokens: 10,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: "end_turn",
      requestMessageCount: 1,
      requestToolCount: 0,
      responseMessageCount: 1,
      responseToolCallCount: undefined,
      responsePreview: "The answer is 42.",
      toolCallNames: undefined,
    });
    expect(normalized.responseSections).toEqual([
      {
        kind: "reasoning",
        label: "Assistant response reasoning",
        role: "assistant",
        text: "I have enough context now.",
      },
      {
        kind: "reasoning",
        label: "Assistant response reasoning",
        role: "assistant",
        text: "[redacted thinking]",
      },
      {
        kind: "message",
        label: "Assistant response",
        role: "assistant",
        text: "The answer is 42.",
      },
    ]);
  });

  test("normalizes plain-text OpenAI requests when the response identifies OpenAI", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_003,
      requestPayload: {
        model: "gpt-4.1",
        messages: [
          { role: "system", content: "Stay brief." },
          { role: "user", content: "What should I pack for Boston?" },
        ],
      },
      responsePayload: {
        model: "gpt-4.1-2026-03-01",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Bring a warm coat and an umbrella.",
            },
          },
        ],
        usage: {
          prompt_tokens: 24,
          completion_tokens: 11,
        },
      },
    });

    expect(normalized.summary).toEqual({
      provider: "openai",
      model: "gpt-4.1-2026-03-01",
      inputTokens: 24,
      outputTokens: 11,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: "stop",
      requestMessageCount: 2,
      requestToolCount: 0,
      responseMessageCount: 1,
      responseToolCallCount: undefined,
      responsePreview: "Bring a warm coat and an umbrella.",
      toolCallNames: undefined,
    });
    expect(normalized.requestSections).toEqual([
      {
        kind: "system",
        label: "System prompt",
        role: "system",
        text: "Stay brief.",
      },
      {
        kind: "message",
        label: "User message 2",
        role: "user",
        text: "What should I pack for Boston?",
      },
    ]);
    expect(normalized.responseSections).toEqual([
      {
        kind: "message",
        label: "Assistant response",
        role: "assistant",
        text: "Bring a warm coat and an umbrella.",
      },
    ]);
  });

  test("normalizes plain-text Anthropic requests when the response identifies Anthropic", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_004,
      requestPayload: {
        model: "claude-sonnet",
        messages: [
          { role: "user", content: "Find the latest changelog entry." },
        ],
      },
      responsePayload: {
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 19,
          output_tokens: 9,
        },
        content: [{ type: "text", text: "I found one from this morning." }],
      },
    });

    expect(normalized.summary).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 19,
      outputTokens: 9,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: "end_turn",
      requestMessageCount: 1,
      requestToolCount: 0,
      responseMessageCount: 1,
      responseToolCallCount: undefined,
      responsePreview: "I found one from this morning.",
      toolCallNames: undefined,
    });
    expect(normalized.requestSections).toEqual([
      {
        kind: "message",
        label: "User message 1",
        role: "user",
        text: "Find the latest changelog entry.",
      },
    ]);
    expect(normalized.responseSections).toEqual([
      {
        kind: "message",
        label: "Assistant response",
        role: "assistant",
        text: "I found one from this morning.",
      },
    ]);
  });

  test("rejects ambiguous request payloads that match OpenAI and Anthropic", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_010,
      requestPayload: {
        model: "gpt-4.1",
        tool_choice: { type: "auto" },
        parallel_tool_calls: true,
        messages: [{ role: "user", content: "Hello there." }],
      },
      responsePayload: {
        model: "gpt-4.1-2026-03-01",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Hello back.",
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
        },
      },
    });

    expect(normalized).toEqual({});
  });

  test("rejects ambiguous response payloads that match OpenAI and Anthropic", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_011,
      requestPayload: {
        model: "gpt-4.1",
        parallel_tool_calls: true,
        messages: [{ role: "user", content: "Hello there." }],
      },
      responsePayload: {
        model: "gpt-4.1-2026-03-01",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Hello back.",
            },
          },
        ],
        content: [{ type: "text", text: "Hello back." }],
        stop_reason: "end_turn",
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
        },
      },
    });

    expect(normalized).toEqual({});
  });

  test("normalizes Anthropic document attachments in request prompt sections", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_009,
      requestPayload: {
        model: "claude-sonnet",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                title: "agenda.pdf",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "JVBERi0xLjQK",
                },
              },
            ],
          },
        ],
      },
      responsePayload: undefined,
    });

    expect(normalized.summary).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
      inputTokens: undefined,
      outputTokens: undefined,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: undefined,
      requestMessageCount: 1,
      requestToolCount: 0,
      responseMessageCount: undefined,
      responseToolCallCount: undefined,
      responsePreview: undefined,
      toolCallNames: undefined,
    });
    expect(normalized.requestSections).toEqual([
      {
        kind: "message",
        label: "User message 1",
        role: "user",
        text: "[document: agenda.pdf]",
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
      responseMessageCount: undefined,
      responseToolCallCount: undefined,
      responsePreview: undefined,
      toolCallNames: undefined,
    });
    expect(normalized.requestSections).toEqual([
      {
        kind: "tool_result",
        label: "User message 1 tool result",
        role: "user",
        toolName: "stu_req_1",
        data: {
          type: "web_search_tool_result",
          tool_use_id: "stu_req_1",
          content: [
            {
              type: "web_search_result",
              url: "https://example.com",
              title: "Example result",
            },
          ],
        },
        text: "[Web search results]",
      },
    ]);
    expect(normalized.responseSections).toEqual([
      {
        kind: "tool_result",
        label: "Assistant response tool result",
        role: "assistant",
        toolName: "stu_resp_1",
        data: {
          type: "web_search_tool_result",
          tool_use_id: "stu_resp_1",
          content: [
            {
              type: "web_search_result",
              url: "https://example.org",
              title: "Another result",
            },
          ],
        },
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

  test("normalizes an OpenAI request with object tool_choice even when the response payload is malformed", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_005,
      requestPayload: {
        model: "gpt-4.1",
        tool_choice: {
          type: "function",
          function: { name: "lookup" },
        },
        messages: [
          {
            role: "system",
            content: "Line 1\n  Line 2",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "First paragraph" },
              { type: "text", text: "  Second line\n    third line" },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Lookup a record",
              parameters: { type: "object" },
            },
          },
        ],
      },
      responsePayload: "not-json",
    });

    expect(normalized.summary).toEqual({
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: undefined,
      outputTokens: undefined,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: undefined,
      requestMessageCount: 2,
      requestToolCount: 1,
      responseMessageCount: undefined,
      responseToolCallCount: undefined,
      responsePreview: undefined,
      toolCallNames: undefined,
    });
    expect(normalized.requestSections).toEqual([
      {
        kind: "system",
        label: "System prompt",
        role: "system",
        text: "Line 1\n  Line 2",
      },
      {
        kind: "message",
        label: "User message 2",
        role: "user",
        text: "First paragraph\n\n  Second line\n    third line",
      },
      {
        kind: "tool_definitions",
        label: "Available tools",
        data: {
          tools: [
            {
              type: "function",
              function: {
                name: "lookup",
                description: "Lookup a record",
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
          tool_choice: {
            type: "function",
            function: { name: "lookup" },
          },
        },
        language: "json",
      },
    ]);
    expect(normalized.responseSections).toBeUndefined();
  });

  test("normalizes an OpenAI response even when the request payload is malformed", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_006,
      requestPayload: "not-json",
      responsePayload: {
        model: "gpt-4.1-2026-03-01",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "First line\n  Second line\n\n    Third line",
            },
          },
        ],
        usage: {
          prompt_tokens: 18,
          completion_tokens: 9,
        },
      },
    });

    expect(normalized.summary).toEqual({
      provider: "openai",
      model: "gpt-4.1-2026-03-01",
      inputTokens: 18,
      outputTokens: 9,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: "stop",
      requestMessageCount: undefined,
      requestToolCount: undefined,
      responseMessageCount: 1,
      responseToolCallCount: undefined,
      responsePreview: "First line Second line Third line",
      toolCallNames: undefined,
    });
    expect(normalized.requestSections).toBeUndefined();
    expect(normalized.responseSections).toEqual([
      {
        kind: "message",
        label: "Assistant response",
        role: "assistant",
        text: "First line\n  Second line\n\n    Third line",
      },
    ]);
  });

  test("does not mix request and response from different providers", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_007,
      requestPayload: {
        model: "gpt-4.1",
        tool_choice: "auto",
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Lookup a record",
              parameters: { type: "object" },
            },
          },
        ],
      },
      responsePayload: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello back." }],
        stop_reason: "end_turn",
      },
    });

    expect(normalized).toEqual({});
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

  // ── OpenAI Responses API normalization tests ──────────────────────────

  test("normalizes OpenAI Responses API request and response payloads", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_020,
      requestPayload: {
        model: "gpt-5.4",
        instructions: "You are a helpful assistant.",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Hello" }],
            type: "message",
          },
          {
            type: "function_call",
            call_id: "call_abc",
            name: "file_read",
            arguments: JSON.stringify({ path: "/tmp" }),
          },
          {
            type: "function_call_output",
            call_id: "call_abc",
            output: "file contents",
          },
        ],
        tools: [
          {
            type: "function",
            name: "file_read",
            description: "Read a file",
            parameters: { type: "object" },
            strict: null,
          },
        ],
        reasoning: { effort: "high" },
        max_output_tokens: 64000,
        stream: true,
        store: false,
      },
      responsePayload: {
        id: "resp_abc123",
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello!" }],
          },
          {
            type: "function_call",
            call_id: "call_def",
            name: "file_read",
            arguments: JSON.stringify({ path: "/a" }),
          },
        ],
        usage: {
          input_tokens: 50,
          output_tokens: 120,
          output_tokens_details: { reasoning_tokens: 80 },
          total_tokens: 170,
        },
        status: "completed",
      },
    });

    expect(normalized.summary).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 50,
      outputTokens: 120,
      stopReason: "stop",
      requestMessageCount: 3,
      requestToolCount: 1,
      responseMessageCount: 1,
      responseToolCallCount: 1,
      responsePreview: "Hello!",
      toolCallNames: ["file_read"],
    });
    expect(normalized.requestSections).toEqual([
      {
        kind: "system",
        label: "System prompt",
        role: "system",
        text: "You are a helpful assistant.",
      },
      {
        kind: "message",
        label: "User message 1",
        role: "user",
        text: "Hello",
      },
      {
        kind: "function_call",
        label: "Request tool call (file_read)",
        role: "assistant",
        toolName: "file_read",
        data: { path: "/tmp" },
        text: '{"path":"/tmp"}',
      },
      {
        kind: "tool_result",
        label: "Tool result (call_abc)",
        role: "tool",
        toolName: "call_abc",
        text: "file contents",
      },
      {
        kind: "tool_definitions",
        label: "Available tools",
        data: {
          tools: [
            {
              type: "function",
              name: "file_read",
              description: "Read a file",
              parameters: { type: "object" },
              strict: null,
            },
          ],
        },
        language: "json",
      },
      {
        kind: "settings",
        label: "Request settings",
        data: {
          model: "gpt-5.4",
          reasoning: { effort: "high" },
          max_output_tokens: 64000,
          stream: true,
          store: false,
        },
        language: "json",
      },
    ]);
    expect(normalized.responseSections).toEqual([
      {
        kind: "message",
        label: "Assistant response",
        role: "assistant",
        text: "Hello!",
      },
      {
        kind: "function_call",
        label: "Response tool call 1",
        role: "assistant",
        toolName: "file_read",
        data: { path: "/a" },
        text: '{"path":"/a"}',
      },
    ]);
  });

  test("normalizes OpenAI Responses API response with text-only output (no tool calls)", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_021,
      requestPayload: {
        model: "gpt-5.4",
        instructions: "Be concise.",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "What is 2+2?" }],
            type: "message",
          },
        ],
      },
      responsePayload: {
        id: "resp_simple",
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "4" }],
          },
        ],
        usage: {
          input_tokens: 15,
          output_tokens: 3,
          total_tokens: 18,
        },
        status: "completed",
      },
    });

    expect(normalized.summary).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 15,
      outputTokens: 3,
      stopReason: "stop",
      requestMessageCount: 1,
      requestToolCount: 0,
      responseMessageCount: 1,
      responseToolCallCount: undefined,
      responsePreview: "4",
      toolCallNames: undefined,
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
        label: "User message 1",
        role: "user",
        text: "What is 2+2?",
      },
    ]);
    expect(normalized.responseSections).toEqual([
      {
        kind: "message",
        label: "Assistant response",
        role: "assistant",
        text: "4",
      },
    ]);
  });

  test("normalizes OpenAI Responses API response even when the request payload is malformed", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_022,
      requestPayload: "not-json",
      responsePayload: {
        id: "resp_orphan",
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "First line\n  Second line" },
            ],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
        status: "completed",
      },
    });

    expect(normalized.summary).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 10,
      outputTokens: 5,
      stopReason: "stop",
      requestMessageCount: undefined,
      requestToolCount: undefined,
      responseMessageCount: 1,
      responseToolCallCount: undefined,
      responsePreview: "First line Second line",
      toolCallNames: undefined,
    });
    expect(normalized.requestSections).toBeUndefined();
    expect(normalized.responseSections).toEqual([
      {
        kind: "message",
        label: "Assistant response",
        role: "assistant",
        text: "First line\n  Second line",
      },
    ]);
  });

  test("normalizes OpenAI Responses API request even when the response payload is malformed", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_023,
      requestPayload: {
        model: "gpt-5.4",
        instructions: "You are helpful.",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Hello" }],
            type: "message",
          },
        ],
        tools: [
          {
            type: "function",
            name: "search",
            description: "Search",
            parameters: { type: "object" },
          },
        ],
      },
      responsePayload: "not-json",
    });

    expect(normalized.summary).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: undefined,
      outputTokens: undefined,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: undefined,
      requestMessageCount: 1,
      requestToolCount: 1,
      responseMessageCount: undefined,
      responseToolCallCount: undefined,
      responsePreview: undefined,
      toolCallNames: undefined,
    });
    expect(normalized.requestSections).toEqual([
      {
        kind: "system",
        label: "System prompt",
        role: "system",
        text: "You are helpful.",
      },
      {
        kind: "message",
        label: "User message 1",
        role: "user",
        text: "Hello",
      },
      {
        kind: "tool_definitions",
        label: "Available tools",
        data: {
          tools: [
            {
              type: "function",
              name: "search",
              description: "Search",
              parameters: { type: "object" },
            },
          ],
        },
        language: "json",
      },
    ]);
    expect(normalized.responseSections).toBeUndefined();
  });

  test("maps Responses API status 'completed' to stop reason 'stop'", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_024,
      requestPayload: {
        model: "gpt-5.4",
        instructions: "Be brief.",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Hi" }],
            type: "message",
          },
        ],
      },
      responsePayload: {
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hey!" }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 2 },
        status: "completed",
      },
    });

    expect(normalized.summary?.stopReason).toBe("stop");
  });

  test("preserves non-completed Responses API status as stop reason", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_025,
      requestPayload: {
        model: "gpt-5.4",
        instructions: "Be brief.",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Hi" }],
            type: "message",
          },
        ],
      },
      responsePayload: {
        model: "gpt-5.4",
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "search",
            arguments: "{}",
          },
        ],
        usage: { input_tokens: 5, output_tokens: 10 },
        status: "incomplete",
      },
    });

    expect(normalized.summary?.stopReason).toBe("incomplete");
  });

  test("legacy chat-completions payloads are still normalized correctly alongside Responses tests", () => {
    // This test verifies backward compatibility: existing chat-completions
    // logs stored in the database must continue to normalize correctly even
    // after the Responses API normalizer was added.
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_026,
      requestPayload: {
        model: "gpt-4.1",
        tool_choice: "auto",
        messages: [
          { role: "system", content: "Be helpful." },
          { role: "user", content: "Hello" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Lookup",
              parameters: { type: "object" },
            },
          },
        ],
      },
      responsePayload: {
        model: "gpt-4.1-2026-03-01",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Hi there!",
            },
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 5,
        },
      },
    });

    expect(normalized.summary).toEqual({
      provider: "openai",
      model: "gpt-4.1-2026-03-01",
      inputTokens: 20,
      outputTokens: 5,
      stopReason: "stop",
      requestMessageCount: 2,
      requestToolCount: 1,
      responseMessageCount: 1,
      responseToolCallCount: undefined,
      responsePreview: "Hi there!",
      toolCallNames: undefined,
    });
  });

  test("does not mix Responses API request with Anthropic response", () => {
    const normalized = normalizeLlmContextPayloads({
      createdAt: 1_742_400_000_027,
      requestPayload: {
        model: "gpt-5.4",
        instructions: "You are helpful.",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Hello" }],
            type: "message",
          },
        ],
      },
      responsePayload: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello back." }],
        stop_reason: "end_turn",
      },
    });

    expect(normalized).toEqual({});
  });
});
