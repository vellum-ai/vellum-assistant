import { afterEach, describe, expect, test } from "bun:test";

import { llmAbstentionChecker, llmGotchasChecker } from "../../judge/llm";

const originalFetch = globalThis.fetch;

interface CapturedRequest {
  url: string | URL | Request;
  init?: RequestInit;
  body?: Record<string, unknown>;
}

function mockOpenAIChatCompletions(responseBody: unknown, status = 200) {
  const captured: CapturedRequest = { url: "" };
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured.url = url;
    captured.init = init;
    if (init?.body !== undefined) {
      captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    }
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

function openAIChatBody(content: string): Record<string, unknown> {
  return { choices: [{ message: { content } }] };
}

describe("llmAbstentionChecker", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns label=true and reason on a positive JSON judgement", async () => {
    mockOpenAIChatCompletions(
      openAIChatBody('{"label": 1, "reason": "identified flaw"}'),
    );

    const result = await llmAbstentionChecker(
      "The premise is wrong because X.",
      "Reject the premise (X is impossible here).",
      {
        evaluatorModel: "gpt-5.2",
        evaluatorApiKey: "unit-test",
        questionItem: { question: "Why does Z fail?" },
      },
    );

    expect(result.label).toBe(true);
    expect(result.reason).toBe("identified flaw");
  });

  test("returns label=false on a JSON judgement with label=0", async () => {
    mockOpenAIChatCompletions(
      openAIChatBody('{"label": 0, "reason": "followed flawed premise"}'),
    );

    const result = await llmAbstentionChecker("X.", "Reject premise.", {
      evaluatorModel: "gpt-5.2",
      evaluatorApiKey: "unit-test",
    });

    expect(result.label).toBe(false);
    expect(result.reason).toBe("followed flawed premise");
  });

  test("posts to /chat/completions with bearer auth and OpenAI body shape", async () => {
    const captured = mockOpenAIChatCompletions(
      openAIChatBody('{"label": 1, "reason": "ok"}'),
    );

    await llmAbstentionChecker("pred", "ans", {
      evaluatorModel: "gpt-5.2",
      evaluatorApiKey: "unit-test",
      evaluatorReasoningEffort: "medium",
      evaluatorMaxCompletionTokens: 2048,
      questionItem: { question: "Q?" },
    });

    expect(String(captured.url)).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(captured.init?.method).toBe("POST");
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer unit-test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(captured.body?.model).toBe("gpt-5.2");
    expect(captured.body?.reasoning_effort).toBe("medium");
    expect(captured.body?.max_completion_tokens).toBe(2048);
    const messages = captured.body?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("flawed-premise");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("Q?");
    expect(messages[1].content).toContain("ans");
  });

  test("respects a custom base URL", async () => {
    const captured = mockOpenAIChatCompletions(
      openAIChatBody('{"label": 1, "reason": "ok"}'),
    );

    await llmAbstentionChecker("pred", "ans", {
      evaluatorModel: "gpt-5.2",
      evaluatorApiKey: "unit-test",
      evaluatorBaseUrl: "http://localhost:8001/v1",
    });

    expect(String(captured.url)).toBe(
      "http://localhost:8001/v1/chat/completions",
    );
  });

  test("throws when evaluatorApiKey is missing and env is unset and no base URL", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        llmAbstentionChecker("p", "a", { evaluatorModel: "gpt-5.2" }),
      ).rejects.toThrow(/API key/);
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });

  test("returns label=false with explanatory reason on empty prediction", async () => {
    // No mock — should short-circuit before any fetch call.
    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;

    const result = await llmAbstentionChecker("", "ref", {
      evaluatorModel: "gpt-5.2",
      evaluatorApiKey: "unit-test",
    });

    expect(result.label).toBe(false);
    expect(result.reason).toContain("empty");
  });

  test("non-2xx HTTP response surfaces as an error with status code", async () => {
    mockOpenAIChatCompletions({ error: "rate limited" }, 429);

    await expect(
      llmAbstentionChecker("p", "a", {
        evaluatorModel: "gpt-5.2",
        evaluatorApiKey: "unit-test",
      }),
    ).rejects.toThrow(/HTTP 429/);
  });

  test("parses code-fenced judgement output", async () => {
    mockOpenAIChatCompletions(
      openAIChatBody('```json\n{"label": 1, "reason": "ok"}\n```'),
    );

    const result = await llmAbstentionChecker("p", "a", {
      evaluatorModel: "gpt-5.2",
      evaluatorApiKey: "unit-test",
    });

    expect(result.label).toBe(true);
    expect(result.reason).toBe("ok");
  });
});

describe("llmGotchasChecker", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uses the gotchas system prompt and rubric", async () => {
    const captured = mockOpenAIChatCompletions(
      openAIChatBody('{"label": 1, "reason": "covers insight"}'),
    );

    await llmGotchasChecker("response covers insight", "insight A; insight B", {
      evaluatorModel: "gpt-5.2",
      evaluatorApiKey: "unit-test",
      questionItem: { question: "What gotcha applies?" },
    });

    const messages = captured.body?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0].content).toContain("gotchas-style insight");
    expect(messages[1].content).toContain("gotcha insight");
    expect(messages[1].content).toContain("insight A; insight B");
  });
});
