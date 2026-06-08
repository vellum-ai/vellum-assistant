import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  Message,
  ToolDefinition,
} from "../providers/types.js";

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

const sampleTools: ToolDefinition[] = [
  {
    name: "file_read",
    description: "Read a file",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "web_search",
    description: "Search the web",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
];

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
        create: async (params: Record<string, unknown>) => {
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
import { FireworksProvider } from "../providers/fireworks/client.js";
import { GeminiProvider } from "../providers/gemini/client.js";
import {
  OpenAIChatCompletionsProvider,
  OpenAIResponsesProvider,
} from "../providers/openai/client.js";

// ---------------------------------------------------------------------------
// App-side web_search provider adapters (Brave/Perplexity/Tavily)
//
// Exercise the real `web-search.ts` execute path with a mocked config, provider
// key, and global fetch. The logger is mocked to capture structured warnings so
// we can assert the `web_search_backend_failure` telemetry (ATL-727).
// ---------------------------------------------------------------------------

let mockWebSearchProvider: string = "brave";
let mockProviderKey: string | undefined = "test-key";
const capturedWarnLogs: Record<string, unknown>[] = [];

const realConfigLoader = await import("../config/loader.js");
mock.module("../config/loader.js", () => ({
  ...realConfigLoader,
  getConfig: () => ({
    services: { "web-search": { provider: mockWebSearchProvider } },
  }),
}));

const realSecureKeys = await import("../security/secure-keys.js");
mock.module("../security/secure-keys.js", () => ({
  ...realSecureKeys,
  getProviderKeyAsync: async () => mockProviderKey,
}));

const realLogger = await import("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, prop) => {
        if (prop === "warn") {
          return (obj: Record<string, unknown>) => {
            capturedWarnLogs.push(obj);
          };
        }
        return () => {};
      },
    }),
}));

const { webSearchTool } = await import("../tools/network/web-search.js");
const { WEB_SEARCH_BACKEND_FAILURE_MESSAGE } = await import(
  "../tools/network/web-search-error.js"
);

function executeWebSearch(input: Record<string, unknown>) {
  return webSearchTool.execute(input, {} as never);
}

function executeWebSearchWithSignal(
  input: Record<string, unknown>,
  signal: AbortSignal,
) {
  return webSearchTool.execute(input, { signal } as never);
}

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
// OpenAI Responses API — native web search tool mapping
// ---------------------------------------------------------------------------

describe("Cross-Provider Web Search — OpenAI (Responses API, native mode)", () => {
  beforeEach(() => {
    lastOpenAIResponsesParams = null;
  });

  test("maps web_search to native web_search_preview tool when useNativeWebSearch is enabled", async () => {
    const provider = new OpenAIResponsesProvider("sk-test", "gpt-4o", {
      useNativeWebSearch: true,
    });

    const tools = [
      {
        name: "file_read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
      {
        name: "web_search",
        description: "Search the web",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ];

    await provider.sendMessage([userMsg("Search for something")], {
      tools,
    });

    const sentTools = lastOpenAIResponsesParams!.tools as Array<
      Record<string, unknown>
    >;
    expect(sentTools).toHaveLength(2);
    // Non-web-search tools stay as function tools
    expect(sentTools[0]).toMatchObject({ type: "function", name: "file_read" });
    // web_search is replaced with native hosted tool
    expect(sentTools[1]).toEqual({ type: "web_search_preview" });
  });

  test("still degrades web search history blocks in native mode", async () => {
    const provider = new OpenAIResponsesProvider("sk-test", "gpt-4o", {
      useNativeWebSearch: true,
    });
    await provider.sendMessage(webSearchConversation());

    const input = lastOpenAIResponsesParams!.input as Array<{
      type: string;
      role?: string;
      content?: Array<{ type: string; text?: string }>;
    }>;

    // server_tool_use in assistant history is still degraded to text placeholder
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

    // web_search_tool_result in user history is still degraded to text placeholder
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
// Fireworks provider tests
// ---------------------------------------------------------------------------

describe("Cross-Provider Web Search — Fireworks", () => {
  beforeEach(() => {
    lastOpenAIChatParams = null;
  });

  test("keeps web_search as an app-executed function tool for managed Brave fallback", async () => {
    const provider = new FireworksProvider(
      "fw-test",
      "accounts/fireworks/models/kimi-k2p6",
    );

    await provider.sendMessage([userMsg("Search for something")], {
      tools: sampleTools,
    });

    const tools = lastOpenAIChatParams!.tools as Array<{
      type: string;
      function: { name: string; description?: string };
    }>;

    expect(tools).toHaveLength(2);
    expect(tools[1]).toMatchObject({
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web",
      },
    });
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

// ---------------------------------------------------------------------------
// App-side provider backend-failure normalization (ATL-727)
// ---------------------------------------------------------------------------

describe("Cross-Provider Web Search — app-side backend failure normalization", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockWebSearchProvider = "brave";
    mockProviderKey = "test-key";
    capturedWarnLogs.length = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function backendFailureLog() {
    return capturedWarnLogs.find(
      (entry) => entry.event === "web_search_backend_failure",
    );
  }

  test("503 from provider yields friendly recoverable copy in content + errorMessage, logs raw 503, no body leak", async () => {
    const rawBody = '{"error":"upstream exploded","trace":"do-not-leak"}';
    globalThis.fetch = (async () =>
      new Response(rawBody, { status: 503 })) as unknown as typeof fetch;

    const result = await executeWebSearch({ query: "needle in a haystack" });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    const meta = result.activityMetadata?.webSearch;
    expect(meta?.errorMessage).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    expect(meta?.results).toEqual([]);
    expect(meta?.resultCount).toBe(0);

    const logEntry = backendFailureLog();
    expect(logEntry).toBeDefined();
    expect(logEntry!.provider).toBe("brave");
    expect(logEntry!.errorCategory).toBe("backend_unavailable");
    expect(logEntry!.fallbackShown).toBe(true);
    expect(logEntry!.queryLength).toBe("needle in a haystack".length);
    expect(String(logEntry!.rawDetail)).toContain("503");
    // Provider diagnostic body is preserved in internal telemetry rawDetail.
    expect(String(logEntry!.rawDetail)).toContain("upstream exploded");
    expect(String(logEntry!.rawDetail)).toContain("do-not-leak");

    // Raw provider body must never reach user-facing fields.
    expect(result.content).not.toContain("upstream exploded");
    expect(result.content).not.toContain("do-not-leak");
    expect(meta?.errorMessage).not.toContain("upstream exploded");
    expect(meta?.errorMessage).not.toContain("do-not-leak");
  });

  test("thrown network error yields the same friendly backend result", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await executeWebSearch({ query: "offline" });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    expect(result.activityMetadata?.webSearch?.errorMessage).toBe(
      WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
    );
    const logEntry = backendFailureLog();
    expect(logEntry).toBeDefined();
    expect(logEntry!.errorCategory).toBe("backend_unavailable");
    expect(result.content).not.toContain("fetch failed");
  });

  test("401 invalid-key preserves the specific message, not the backend copy", async () => {
    globalThis.fetch = (async () =>
      new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;

    const result = await executeWebSearch({ query: "bad key" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid or expired Brave Search API key");
    expect(result.content).not.toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    expect(result.activityMetadata?.webSearch?.errorMessage).not.toBe(
      WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
    );
    expect(backendFailureLog()).toBeUndefined();
  });

  test("HTTP 200 with zero results stays a success (unchanged)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await executeWebSearch({ query: "no hits" });

    expect(result.isError).toBe(false);
    expect(result.activityMetadata?.webSearch?.errorMessage).toBeUndefined();
    expect(result.content).toContain("No results found");
    expect(backendFailureLog()).toBeUndefined();
  });

  test("post-retry 429 yields the friendly recoverable copy and preserves body in rawDetail", async () => {
    const rawBody = '{"error":"quota burned","retryHint":"do-not-leak-429"}';
    globalThis.fetch = (async () =>
      new Response(rawBody, {
        status: 429,
        headers: { "retry-after": "0" },
      })) as unknown as typeof fetch;

    const result = await executeWebSearch({ query: "rate limited" });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    const meta = result.activityMetadata?.webSearch;
    expect(meta?.errorMessage).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
    const logEntry = backendFailureLog();
    expect(logEntry).toBeDefined();
    expect(logEntry!.errorCategory).toBe("rate_limited");
    expect(String(logEntry!.rawDetail)).toContain("429");
    // Provider diagnostic body is preserved in internal telemetry rawDetail.
    expect(String(logEntry!.rawDetail)).toContain("quota burned");
    expect(String(logEntry!.rawDetail)).toContain("do-not-leak-429");

    // Raw provider body must never reach user-facing fields.
    expect(result.content).not.toContain("quota burned");
    expect(result.content).not.toContain("do-not-leak-429");
    expect(meta?.errorMessage).not.toContain("quota burned");
    expect(meta?.errorMessage).not.toContain("do-not-leak-429");
  });

  test("caller abort re-throws instead of producing a backend failure (no telemetry)", async () => {
    const controller = new AbortController();
    controller.abort();

    // A caller-aborted request surfaces an AbortError from fetch.
    globalThis.fetch = (async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      throw abortError;
    }) as unknown as typeof fetch;

    // The cancellation must re-throw so the executor's abort handling takes
    // over — NOT resolve to the friendly backend-failure result.
    await expect(
      executeWebSearchWithSignal({ query: "cancel me" }, controller.signal),
    ).rejects.toThrow();

    // No spurious backend-failure telemetry for a user/external cancellation.
    expect(backendFailureLog()).toBeUndefined();
  });
});
