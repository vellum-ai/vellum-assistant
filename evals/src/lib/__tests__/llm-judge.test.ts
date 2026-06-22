import { afterEach, describe, expect, test } from "bun:test";

import { DEFAULT_JUDGE_MODEL, classifyWithJudge } from "../llm-judge";

const originalFetch = globalThis.fetch;

const TOOL = {
  name: "report_largest_category",
  description: "Report the largest category.",
  inputSchema: {
    type: "object" as const,
    properties: { category: { type: "string" } },
    required: ["category"],
  },
};

describe("classifyWithJudge", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("forces the tool call and returns its parsed input", async () => {
    // GIVEN a judge that answers via the forced tool call
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "report_largest_category",
              input: { category: "Labor" },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    // WHEN classifying an answer
    const verdict = await classifyWithJudge({
      system: "grade it",
      user: "Labor was the largest.",
      tool: TOOL,
      apiKey: "test-key",
    });

    // THEN the tool input comes back, and the request pins Haiku + tool_choice
    expect(verdict).toEqual({ category: "Labor" });
    expect(requestBody.model).toBe(DEFAULT_JUDGE_MODEL);
    expect(requestBody.tool_choice).toEqual({
      type: "tool",
      name: "report_largest_category",
    });
    expect(requestBody.temperature).toBe(0);
  });

  test("throws when no API key is available", async () => {
    // GIVEN no key on the call or in the environment
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    // WHEN/THEN classifying rejects with a clear message
    await expect(
      classifyWithJudge({ system: "s", user: "u", tool: TOOL }),
    ).rejects.toThrow("ANTHROPIC_API_KEY is required");

    if (previous) process.env.ANTHROPIC_API_KEY = previous;
  });

  test("throws when the response carries no matching tool call", async () => {
    // GIVEN a response with only free text (no tool_use)
    globalThis.fetch = (async (_url: string | URL | Request) =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
        {
          status: 200,
        },
      )) as typeof fetch;

    // WHEN/THEN classifying surfaces the missing-tool-call failure
    await expect(
      classifyWithJudge({
        system: "s",
        user: "u",
        tool: TOOL,
        apiKey: "test-key",
      }),
    ).rejects.toThrow("no report_largest_category tool call");
  });

  test("throws on a non-OK HTTP response", async () => {
    // GIVEN the API returns 429
    globalThis.fetch = (async (_url: string | URL | Request) =>
      new Response("rate limited", { status: 429 })) as typeof fetch;

    // WHEN/THEN the failure is surfaced with the status
    await expect(
      classifyWithJudge({
        system: "s",
        user: "u",
        tool: TOOL,
        apiKey: "test-key",
      }),
    ).rejects.toThrow("LLM judge request failed 429");
  });
});
