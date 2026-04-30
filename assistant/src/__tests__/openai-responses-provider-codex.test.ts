import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../providers/types.js";

interface FakeStreamEvent {
  type: string;
  [key: string]: unknown;
}

let fakeStreamEvents: FakeStreamEvent[] = [];
let lastStreamParams: Record<string, unknown> | null = null;
let lastConstructorOptions: Record<string, unknown> | null = null;
let constructorCalls: Array<Record<string, unknown>> = [];
let throwQueue: (Error | null)[] = [];

class FakeAPIError extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(
    status: number,
    message: string,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.headers = headers ?? {};
    this.name = "APIError";
  }
}

mock.module("openai", () => ({
  default: class MockOpenAI {
    static APIError = FakeAPIError;
    constructor(opts: Record<string, unknown>) {
      lastConstructorOptions = opts;
      constructorCalls.push(opts);
    }
    responses = {
      stream: (params: Record<string, unknown>) => {
        lastStreamParams = params;
        const next = throwQueue.shift();
        if (next) throw next;
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const event of fakeStreamEvents) yield event;
          },
        };
      },
    };
  },
}));

const { OpenAIResponsesProvider } =
  await import("../providers/openai/responses-provider.js");

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

function completedEvent(): FakeStreamEvent {
  return {
    type: "response.completed",
    response: {
      model: "gpt-5.5",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

beforeEach(() => {
  fakeStreamEvents = [completedEvent()];
  lastStreamParams = null;
  lastConstructorOptions = null;
  constructorCalls = [];
  throwQueue = [];
});

describe("OpenAIResponsesProvider Codex compatibility", () => {
  test("strips max_output_tokens when baseURL is Codex", async () => {
    const provider = new OpenAIResponsesProvider("access-tok", "gpt-5.5", {
      baseURL: CODEX_BASE_URL,
    });
    await provider.sendMessage([userMessage], undefined, "system", {
      config: { max_tokens: 1024 } as Record<string, unknown>,
    });
    expect(lastStreamParams).not.toBeNull();
    expect(lastStreamParams!.max_output_tokens).toBeUndefined();
    expect(lastStreamParams!.model).toBe("gpt-5.5");
    expect(lastStreamParams!.store).toBe(false);
    expect(lastStreamParams!.instructions).toBe("system");
  });

  test("includes max_output_tokens for the standard OpenAI base URL", async () => {
    const provider = new OpenAIResponsesProvider("sk-test", "gpt-5.2", {});
    await provider.sendMessage([userMessage], undefined, "system", {
      config: { max_tokens: 2048 } as Record<string, unknown>,
    });
    expect(lastStreamParams!.max_output_tokens).toBe(2048);
  });

  test("forwards defaultHeaders to the OpenAI client constructor", async () => {
    new OpenAIResponsesProvider("access-tok", "gpt-5.5", {
      baseURL: CODEX_BASE_URL,
      defaultHeaders: {
        "chatgpt-account-id": "account-test",
        "OpenAI-Beta": "responses=experimental",
        originator: "vellum-assistant",
      },
    });
    expect(lastConstructorOptions).not.toBeNull();
    expect(lastConstructorOptions!.baseURL).toBe(CODEX_BASE_URL);
    expect(lastConstructorOptions!.defaultHeaders).toEqual({
      "chatgpt-account-id": "account-test",
      "OpenAI-Beta": "responses=experimental",
      originator: "vellum-assistant",
    });
  });

  test("rebuilds the client and retries once on 401 when onAuthRefreshNeeded returns a fresh token", async () => {
    throwQueue.push(new FakeAPIError(401, "unauthorized"));
    const provider = new OpenAIResponsesProvider("stale-tok", "gpt-5.5", {
      baseURL: CODEX_BASE_URL,
      onAuthRefreshNeeded: async () => "fresh-tok",
    });
    const result = await provider.sendMessage(
      [userMessage],
      undefined,
      "system",
    );
    expect(result).toBeDefined();
    expect(constructorCalls.length).toBe(2);
    expect(constructorCalls[0]!.apiKey).toBe("stale-tok");
    expect(constructorCalls[1]!.apiKey).toBe("fresh-tok");
  });

  test("does not retry when onAuthRefreshNeeded returns undefined", async () => {
    throwQueue.push(new FakeAPIError(401, "unauthorized"));
    const provider = new OpenAIResponsesProvider("stale-tok", "gpt-5.5", {
      baseURL: CODEX_BASE_URL,
      onAuthRefreshNeeded: async () => undefined,
    });
    await expect(
      provider.sendMessage([userMessage], undefined, "system"),
    ).rejects.toThrow();
    expect(constructorCalls.length).toBe(1);
  });

  test("does not retry on 401 without onAuthRefreshNeeded callback", async () => {
    throwQueue.push(new FakeAPIError(401, "unauthorized"));
    const provider = new OpenAIResponsesProvider("sk-test", "gpt-5.2", {});
    await expect(
      provider.sendMessage([userMessage], undefined, "system"),
    ).rejects.toThrow();
    expect(constructorCalls.length).toBe(1);
  });
});
