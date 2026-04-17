import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ContentBlock, Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

/** A conversation with web search blocks in history (as Anthropic would produce). */
function webSearchConversation(): Message[] {
  return [
    userMsg("Search for something"),
    {
      role: "assistant",
      content: [
        {
          type: "server_tool_use",
          id: "stu_abc123",
          name: "web_search",
          input: { query: "test query" },
        } satisfies ContentBlock,
        {
          type: "text",
          text: "Here are the results.",
        } satisfies ContentBlock,
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "web_search_tool_result",
          tool_use_id: "stu_abc123",
          content: [
            {
              type: "web_search_result",
              url: "https://example.com",
              title: "Example",
              encrypted_content: "enc_abc",
            },
          ],
        } satisfies ContentBlock,
      ],
    },
    userMsg("Thanks, now do something else"),
  ];
}

/** A message containing only a web_search_tool_result block (edge case). */
function webSearchResultOnlyMessage(): Message[] {
  return [
    userMsg("Search for something"),
    {
      role: "assistant",
      content: [
        {
          type: "server_tool_use",
          id: "stu_only",
          name: "web_search",
          input: { query: "lonely query" },
        } satisfies ContentBlock,
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "web_search_tool_result",
          tool_use_id: "stu_only",
          content: [
            {
              type: "web_search_result",
              url: "https://example.com",
              title: "Example",
              encrypted_content: "enc_xyz",
            },
          ],
        } satisfies ContentBlock,
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Mock OpenAI SDK
// ---------------------------------------------------------------------------

let lastOpenAIResponsesParams: Record<string, unknown> | null = null;
let lastOpenAIChatParams: Record<string, unknown> | null = null;

mock.module("openai", () => {
  class FakeAPIError extends Error {
    status: number;
    headers: Record<string, string>;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.headers = {};
      this.name = "APIError";
    }
  }

  return {
    default: class MockOpenAI {
      static APIError = FakeAPIError;
      constructor(_args: Record<string, unknown>) {}
      chat = {
        completions: {
          create: (params: Record<string, unknown>) => {
            lastOpenAIChatParams = JSON.parse(JSON.stringify(params));
            return (async function* () {
              yield {
                choices: [
                  {
                    delta: { content: "OK" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
                model: "gpt-4o",
              };
            })();
          },
        },
      };
      responses = {
        stream: (params: Record<string, unknown>) => {
          lastOpenAIResponsesParams = JSON.parse(JSON.stringify(params));
          return (async function* () {
            yield {
              type: "response.output_text.delta",
              delta: "OK",
            };
            yield {
              type: "response.completed",
              response: {
                model: "gpt-4o",
                status: "completed",
                usage: {
                  input_tokens: 10,
                  output_tokens: 5,
                },
              },
            };
          })();
        },
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Mock Gemini SDK
// ---------------------------------------------------------------------------

let lastGeminiParams: Record<string, unknown> | null = null;

mock.module("@google/genai", () => {
  class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "ApiError";
    }
  }

  return {
    ApiError: FakeApiError,
    GoogleGenAI: class MockGoogleGenAI {
      constructor(_args: Record<string, unknown>) {}
      models = {
        generateContentStream: (params: Record<string, unknown>) => {
          lastGeminiParams = JSON.parse(JSON.stringify(params));
          return (async function* () {
            yield {
              text: "OK",
              candidates: [{ finishReason: "STOP" }],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
              },
              modelVersion: "gemini-2.0-flash",
            };
          })();
        },
      };
    },
  };
});

// Import providers after mocking
import { GeminiProvider } from "../providers/gemini/client.js";
import {
  OpenAIChatCompletionsProvider,
  OpenAIResponsesProvider,
} from "../providers/openai/client.js";

// ---------------------------------------------------------------------------
// OpenAI Responses API provider tests
// ---------------------------------------------------------------------------

describe("Cross-Provider Web Search — OpenAI (Responses API)", () => {
  beforeEach(() => {
    lastOpenAIResponsesParams = null;
  });

  test("degrades server_tool_use in assistant message to text placeholder in Responses input", async () => {
    const provider = new OpenAIResponsesProvider("sk-test", "gpt-4o");
    await provider.sendMessage(webSearchConversation());

    const input = lastOpenAIResponsesParams!.input as Array<{
      type: string;
      role?: string;
      content?: Array<{ type: string; text?: string }>;
    }>;

    const assistantItems = input.filter(
      (item) => item.type === "message" && item.role === "assistant",
    );
    const hasWebSearchPlaceholder = assistantItems.some((item) =>
      item.content?.some(
        (part) =>
          part.type === "output_text" &&
          part.text?.includes("[Web search: web_search]"),
      ),
    );
    expect(hasWebSearchPlaceholder).toBe(true);

    const hasResultsText = assistantItems.some((item) =>
      item.content?.some(
        (part) =>
          part.type === "output_text" &&
          part.text?.includes("Here are the results."),
      ),
    );
    expect(hasResultsText).toBe(true);
  });

  test("degrades web_search_tool_result in user message to text placeholder in Responses input", async () => {
    const provider = new OpenAIResponsesProvider("sk-test", "gpt-4o");
    await provider.sendMessage(webSearchConversation());

    const input = lastOpenAIResponsesParams!.input as Array<{
      type: string;
      role?: string;
      content?: Array<{ type: string; text?: string }>;
    }>;

    const userItems = input.filter(
      (item) => item.type === "message" && item.role === "user",
    );
    const hasWebSearchResult = userItems.some((item) =>
      item.content?.some(
        (part) =>
          part.type === "input_text" && part.text === "[Web search results]",
      ),
    );
    expect(hasWebSearchResult).toBe(true);
  });

  test("handles message containing only web_search_tool_result", async () => {
    const provider = new OpenAIResponsesProvider("sk-test", "gpt-4o");
    await provider.sendMessage(webSearchResultOnlyMessage());

    const input = lastOpenAIResponsesParams!.input as Array<{
      type: string;
      role?: string;
      content?: Array<{ type: string; text?: string }>;
    }>;

    const assistantItems = input.filter(
      (item) => item.type === "message" && item.role === "assistant",
    );
    const hasWebSearchPlaceholder = assistantItems.some((item) =>
      item.content?.some(
        (part) =>
          part.type === "output_text" &&
          part.text?.includes("[Web search: web_search]"),
      ),
    );
    expect(hasWebSearchPlaceholder).toBe(true);

    const userItems = input.filter(
      (item) => item.type === "message" && item.role === "user",
    );
    const hasWebSearchResult = userItems.some((item) =>
      item.content?.some(
        (part) =>
          part.type === "input_text" && part.text === "[Web search results]",
      ),
    );
    expect(hasWebSearchResult).toBe(true);
  });

  test("does not produce function_call items for server_tool_use blocks", async () => {
    const provider = new OpenAIResponsesProvider("sk-test", "gpt-4o");
    await provider.sendMessage(webSearchConversation());

    const input = lastOpenAIResponsesParams!.input as Array<{
      type: string;
    }>;

    const functionCallItems = input.filter(
      (item) => item.type === "function_call",
    );
    expect(functionCallItems).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OpenAI Chat Completions compatibility provider tests
// ---------------------------------------------------------------------------

describe("Cross-Provider Web Search — OpenAI Chat Completions (compatibility)", () => {
  beforeEach(() => {
    lastOpenAIChatParams = null;
  });

  test("degrades server_tool_use in assistant message to text placeholder", async () => {
    const provider = new OpenAIChatCompletionsProvider("sk-test", "gpt-4o");
    await provider.sendMessage(webSearchConversation());

    const messages = lastOpenAIChatParams!.messages as Array<{
      role: string;
      content: unknown;
    }>;

    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toContain("[Web search: web_search]");
    expect(assistantMsg!.content).toContain("Here are the results.");
  });

  test("degrades web_search_tool_result in user message to text placeholder", async () => {
    const provider = new OpenAIChatCompletionsProvider("sk-test", "gpt-4o");
    await provider.sendMessage(webSearchConversation());

    const messages = lastOpenAIChatParams!.messages as Array<{
      role: string;
      content: unknown;
    }>;

    const userMsgs = messages.filter((m) => m.role === "user");
    const hasWebSearchResult = userMsgs.some((m) => {
      if (typeof m.content === "string") return false;
      if (Array.isArray(m.content)) {
        return (m.content as Array<{ type: string; text?: string }>).some(
          (part) =>
            part.type === "text" && part.text === "[Web search results]",
        );
      }
      return false;
    });
    expect(hasWebSearchResult).toBe(true);
  });

  test("does not produce tool_calls for server_tool_use blocks", async () => {
    const provider = new OpenAIChatCompletionsProvider("sk-test", "gpt-4o");
    await provider.sendMessage(webSearchConversation());

    const messages = lastOpenAIChatParams!.messages as Array<{
      role: string;
      tool_calls?: unknown[];
    }>;

    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.tool_calls).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gemini provider tests
// ---------------------------------------------------------------------------

describe("Cross-Provider Web Search — Gemini", () => {
  beforeEach(() => {
    lastGeminiParams = null;
  });

  test("degrades server_tool_use in model message to text placeholder", async () => {
    const provider = new GeminiProvider("key-test", "gemini-2.0-flash");
    await provider.sendMessage(webSearchConversation());

    const contents = lastGeminiParams!.contents as Array<{
      role: string;
      parts: Array<{ text?: string; functionCall?: unknown }>;
    }>;

    const modelContent = contents.find((c) => c.role === "model");
    expect(modelContent).toBeDefined();

    const webSearchPart = modelContent!.parts.find(
      (p) => p.text === "[Web search: web_search]",
    );
    expect(webSearchPart).toBeDefined();

    const textPart = modelContent!.parts.find(
      (p) => p.text === "Here are the results.",
    );
    expect(textPart).toBeDefined();
  });

  test("degrades web_search_tool_result in user message to text placeholder", async () => {
    const provider = new GeminiProvider("key-test", "gemini-2.0-flash");
    await provider.sendMessage(webSearchConversation());

    const contents = lastGeminiParams!.contents as Array<{
      role: string;
      parts: Array<{ text?: string }>;
    }>;

    const userContents = contents.filter((c) => c.role === "user");
    const hasWebSearchResult = userContents.some((c) =>
      c.parts.some((p) => p.text === "[Web search results]"),
    );
    expect(hasWebSearchResult).toBe(true);
  });

  test("handles message containing only web_search_tool_result", async () => {
    const provider = new GeminiProvider("key-test", "gemini-2.0-flash");
    await provider.sendMessage(webSearchResultOnlyMessage());

    const contents = lastGeminiParams!.contents as Array<{
      role: string;
      parts: Array<{ text?: string; functionCall?: unknown }>;
    }>;

    const modelContent = contents.find((c) => c.role === "model");
    expect(modelContent).toBeDefined();
    const webSearchPart = modelContent!.parts.find(
      (p) => p.text === "[Web search: web_search]",
    );
    expect(webSearchPart).toBeDefined();

    const userContents = contents.filter((c) => c.role === "user");
    const hasWebSearchResult = userContents.some((c) =>
      c.parts.some((p) => p.text === "[Web search results]"),
    );
    expect(hasWebSearchResult).toBe(true);
  });

  test("does not produce functionCall parts for server_tool_use blocks", async () => {
    const provider = new GeminiProvider("key-test", "gemini-2.0-flash");
    await provider.sendMessage(webSearchConversation());

    const contents = lastGeminiParams!.contents as Array<{
      role: string;
      parts: Array<{ text?: string; functionCall?: unknown }>;
    }>;

    const modelContent = contents.find((c) => c.role === "model");
    expect(modelContent).toBeDefined();
    const functionCallParts = modelContent!.parts.filter(
      (p) => p.functionCall !== undefined,
    );
    expect(functionCallParts).toHaveLength(0);
  });
});
