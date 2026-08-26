import { describe, expect, test } from "bun:test";

import {
  lookupOpenRouterModel,
  normalizeOpenRouterModelId,
  openRouterDisplayName,
  OpenRouterModelIdInvalidError,
  OpenRouterModelNotFoundError,
} from "./lookup-model.js";

describe("normalizeOpenRouterModelId", () => {
  test("accepts author/slug and strips a leading tilde", () => {
    expect(normalizeOpenRouterModelId(" x-ai/grok-4.6 ")).toBe("x-ai/grok-4.6");
    expect(normalizeOpenRouterModelId("~openai/gpt-4o")).toBe("openai/gpt-4o");
    expect(normalizeOpenRouterModelId("openrouter/free:variant")).toBe(
      "openrouter/free:variant",
    );
  });

  test("rejects empty, dotted, and extra-slash ids", () => {
    expect(normalizeOpenRouterModelId("")).toBeNull();
    expect(normalizeOpenRouterModelId("   ")).toBeNull();
    expect(normalizeOpenRouterModelId("grok-4.6")).toBeNull();
    expect(normalizeOpenRouterModelId("x-ai/../secret")).toBeNull();
    expect(normalizeOpenRouterModelId("a/b/c")).toBeNull();
    expect(normalizeOpenRouterModelId("x-ai/grok 4.6")).toBeNull();
  });
});

describe("openRouterDisplayName", () => {
  test("strips the vendor prefix OpenRouter puts on names", () => {
    expect(openRouterDisplayName("SpaceXAI: Grok 4.6", "x-ai/grok-4.6")).toBe(
      "Grok 4.6",
    );
    expect(openRouterDisplayName("Z.ai: GLM 5.3 Flash", "z-ai/glm-5.3-flash")).toBe(
      "GLM 5.3 Flash",
    );
  });

  test("falls back to the id when the name is empty", () => {
    expect(openRouterDisplayName("", "x-ai/grok-4.6")).toBe("x-ai/grok-4.6");
    expect(openRouterDisplayName("   ", "x-ai/grok-4.6")).toBe("x-ai/grok-4.6");
  });
});

describe("lookupOpenRouterModel", () => {
  test("maps a successful OpenRouter payload", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://openrouter.ai/api/v1/model/x-ai/grok-4.6",
      );
      return new Response(
        JSON.stringify({
          data: {
            id: "x-ai/grok-4.6",
            name: "SpaceXAI: Grok 4.6",
            context_length: 500000,
            top_provider: { max_completion_tokens: 450000 },
            supported_parameters: ["reasoning", "tools"],
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await expect(lookupOpenRouterModel("x-ai/grok-4.6", fetchImpl)).resolves.toEqual(
      {
        id: "x-ai/grok-4.6",
        displayName: "Grok 4.6",
        contextWindowTokens: 500000,
        maxOutputTokens: 450000,
        supportsThinking: true,
      },
    );
  });

  test("404s become OpenRouterModelNotFoundError", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "Not Found" } }), {
        status: 404,
      })) as unknown as typeof fetch;

    await expect(
      lookupOpenRouterModel("missing/model", fetchImpl),
    ).rejects.toBeInstanceOf(OpenRouterModelNotFoundError);
  });

  test("rejects an invalid id before fetching", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      lookupOpenRouterModel("not-a-model", fetchImpl),
    ).rejects.toBeInstanceOf(OpenRouterModelIdInvalidError);
    expect(called).toBe(false);
  });
});
