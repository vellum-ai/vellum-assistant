import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock OpenAI SDK — must be before importing the provider
// ---------------------------------------------------------------------------

let lastCreateParams: Record<string, unknown> | null = null;

/** Minimal async-iterable stream that yields one text chunk then a usage chunk. */
function makeFakeStream() {
  const chunks = [
    {
      choices: [
        {
          delta: { content: "Hello" },
          finish_reason: null,
        },
      ],
      model: "gpt-5",
      usage: null,
    },
    {
      choices: [
        {
          delta: {},
          finish_reason: "stop",
        },
      ],
      model: "gpt-5",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
      },
    },
  ];
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

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

mock.module("openai", () => ({
  default: class MockOpenAI {
    static APIError = FakeAPIError;
    chat = {
      completions: {
        create: (params: Record<string, unknown>) => {
          lastCreateParams = JSON.parse(JSON.stringify(params));
          return Promise.resolve(makeFakeStream());
        },
      },
    };
    models = {
      list: () => Promise.resolve({ data: [] }),
    };
  },
}));

// Import after mocking
import { OpenAIProvider } from "../providers/openai/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAIProvider reasoning_effort", () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    lastCreateParams = null;
    provider = new OpenAIProvider("test-key", "gpt-5");
  });

  test('effort: "low" maps to reasoning_effort: "low"', async () => {
    await provider.sendMessage([userMsg("hi")], undefined, "system", {
      config: { effort: "low" },
    });
    expect(lastCreateParams).toBeTruthy();
    expect(lastCreateParams!.reasoning_effort).toBe("low");
  });

  test('effort: "medium" maps to reasoning_effort: "medium"', async () => {
    await provider.sendMessage([userMsg("hi")], undefined, "system", {
      config: { effort: "medium" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("medium");
  });

  test('effort: "high" maps to reasoning_effort: "high"', async () => {
    await provider.sendMessage([userMsg("hi")], undefined, "system", {
      config: { effort: "high" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("high");
  });

  test('effort: "max" maps to reasoning_effort: "high"', async () => {
    await provider.sendMessage([userMsg("hi")], undefined, "system", {
      config: { effort: "max" },
    });
    expect(lastCreateParams!.reasoning_effort).toBe("high");
  });

  test("no effort config means no reasoning_effort in params", async () => {
    await provider.sendMessage([userMsg("hi")], undefined, "system", {
      config: {},
    });
    expect(lastCreateParams).toBeTruthy();
    expect(lastCreateParams!.reasoning_effort).toBeUndefined();
  });

  test("extraCreateParams reasoning_effort is not clobbered when no effort is set", async () => {
    const providerWithExtra = new OpenAIProvider("test-key", "gpt-5", {
      extraCreateParams: { reasoning_effort: "medium" },
    });
    await providerWithExtra.sendMessage([userMsg("hi")], undefined, "system", {
      config: {},
    });
    expect(lastCreateParams!.reasoning_effort).toBe("medium");
  });
});
