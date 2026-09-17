import { afterEach, describe, expect, test } from "bun:test";

import { ProviderError } from "../../util/errors.js";
import {
  conversationToState,
  DEFAULT_JEV_MODEL,
  JevProvider,
  parseSystemOneOverride,
  validateJevApiKey,
} from "./client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return impl as unknown as typeof fetch;
}

describe("parseSystemOneOverride", () => {
  test("reads a TypeSafe questions payload from the last user message", () => {
    const parsed = parseSystemOneOverride(
      JSON.stringify({
        questions: {
          urgency: {
            type: "noul",
            instructions: "Does this message express urgency?",
          },
        },
      }),
    );
    expect(parsed?.questions.urgency?.type).toBe("noul");
    expect(parsed?.state).toBeUndefined();
  });

  test("forwards an explicit state when present", () => {
    const parsed = parseSystemOneOverride(
      JSON.stringify({
        state: "Cancel my subscription",
        questions: {
          intent: {
            type: "choice",
            instructions: "What does the user want?",
            criteria: { cancel: "Cancellation", refund: "Refund" },
          },
        },
      }),
    );
    expect(parsed?.state).toBe("Cancel my subscription");
    expect(parsed?.questions.intent?.type).toBe("choice");
  });

  test("ignores ordinary chat text", () => {
    expect(parseSystemOneOverride("Cancel my subscription")).toBeNull();
  });
});

describe("conversationToState", () => {
  test("flattens system prompt and turns into a string", () => {
    const state = conversationToState(
      [
        {
          role: "user",
          content: [{ type: "text", text: "Cancel my subscription" }],
        },
      ],
      "You are a helpful assistant.",
    );
    expect(state).toContain("system:\nYou are a helpful assistant.");
    expect(state).toContain("user:\nCancel my subscription");
  });
});

describe("validateJevApiKey", () => {
  test("rejects a 401 from the models endpoint", async () => {
    globalThis.fetch = stubFetch(async () =>
      jsonResponse({ error: "nope" }, 401),
    );
    const result = await validateJevApiKey("bad-key");
    expect(result).toEqual({
      valid: false,
      reason: "API key is invalid or expired.",
    });
  });

  test("falls back to System One when /v1/models is unpublished", async () => {
    const urls: string[] = [];
    globalThis.fetch = stubFetch(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/v1/models")) {
        return jsonResponse({ error: "missing" }, 404);
      }
      return jsonResponse({
        model: DEFAULT_JEV_MODEL,
        answers: { probe: { type: "noul", noul: 1 } },
      });
    });
    const result = await validateJevApiKey("sk-test");
    expect(result).toEqual({ valid: true });
    expect(urls.some((url) => url.endsWith("/v1/systemone"))).toBe(true);
  });

  test("allows the key on transient 429s", async () => {
    globalThis.fetch = stubFetch(async () =>
      jsonResponse({ error: "slow down" }, 429),
    );
    const result = await validateJevApiKey("sk-test");
    expect(result).toEqual({ valid: true });
  });
});

describe("JevProvider.sendMessage", () => {
  test("evaluates conversation state with the default experiment noul", async () => {
    let captured: { url: string; body: unknown } | undefined;
    globalThis.fetch = stubFetch(async (input, init) => {
      captured = {
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      };
      return jsonResponse({
        model: "jev-latest",
        answers: { actionable: { type: "noul", noul: 0.91 } },
        usage: { input_tokens: 12, output_tokens: 4 },
      });
    });

    const provider = new JevProvider("sk-test", "jev-latest");
    const deltas: string[] = [];
    const response = await provider.sendMessage(
      [
        {
          role: "user",
          content: [{ type: "text", text: "Please cancel this charge." }],
        },
      ],
      {
        onEvent: (event) => {
          if (event.type === "text_delta") {
            deltas.push(event.text);
          }
        },
      },
    );

    expect(captured?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(captured?.body).toMatchObject({
      model: "jev-latest",
      questions: {
        actionable: {
          type: "noul",
          instructions:
            "Does the latest user message ask the assistant to take a specific action?",
        },
      },
    });
    expect(String((captured?.body as { state: string }).state)).toContain(
      "Please cancel this charge.",
    );
    expect(response.model).toBe("jev-latest");
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
    expect(response.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(
        { actionable: { type: "noul", noul: 0.91 } },
        null,
        2,
      ),
    });
    expect(deltas.join("")).toBe(
      response.content[0] && "text" in response.content[0]
        ? response.content[0].text
        : "",
    );
  });

  test("forwards an explicit System One payload from the last user message", async () => {
    let captured: unknown;
    globalThis.fetch = stubFetch(async (_input, init) => {
      captured = JSON.parse(String(init?.body ?? "{}")) as unknown;
      return jsonResponse({
        model: "jev-latest",
        answers: {
          department: {
            type: "choice",
            choice: "billing",
            probabilities: { billing: 0.8, technical: 0.2 },
            confidence: 0.6,
          },
        },
      });
    });

    const provider = new JevProvider("sk-test", "jev-latest");
    await provider.sendMessage([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              state: "I was charged twice.",
              questions: {
                department: {
                  type: "choice",
                  instructions: "Which team should handle this?",
                  criteria: {
                    billing: "Payments",
                    technical: "Bugs",
                  },
                },
              },
            }),
          },
        ],
      },
    ]);

    expect(captured).toMatchObject({
      model: "jev-latest",
      state: "I was charged twice.",
      questions: {
        department: {
          type: "choice",
          instructions: "Which team should handle this?",
        },
      },
    });
  });

  test("throws ProviderError with invalid_credentials on 401", async () => {
    globalThis.fetch = stubFetch(async () =>
      jsonResponse({ error: { message: "bad key" } }, 401),
    );
    const provider = new JevProvider("sk-test", "jev-latest");
    try {
      await provider.sendMessage([
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ]);
      throw new Error("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.statusCode).toBe(401);
      expect(providerError.reason).toBe("invalid_credentials");
      expect(providerError.message).toBe("bad key");
    }
  });
});
