/**
 * Verifies the IO Intelligence (io.net) provider wiring: the SDK client must
 * resolve to the documented IO Intelligence chat-completions endpoint unless
 * an explicit override is supplied (custom-connection / test usage).
 */

import { describe, expect, test } from "bun:test";

import { IonetProvider } from "./client.js";

type MockChunk = {
  choices: Array<{
    delta: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

const OK_CHUNKS: MockChunk[] = [
  {
    choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  },
];

function makeStream(chunks: MockChunk[]): AsyncIterable<MockChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield c;
      }
    },
  };
}

function clientOf(provider: IonetProvider) {
  return (
    provider as unknown as {
      client: {
        baseURL: string;
        chat: {
          completions: {
            create: (params: unknown) => Promise<AsyncIterable<MockChunk>>;
          };
        };
      };
    }
  ).client;
}

describe("IonetProvider", () => {
  test("defaults the SDK client to the IO Intelligence endpoint", async () => {
    const provider = new IonetProvider(
      "test-key",
      "meta-llama/Llama-3.3-70B-Instruct",
    );

    const client = clientOf(provider);
    expect(client.baseURL).toBe("https://api.intelligence.io.solutions/api/v1");

    // The same base URL must be reported on the response, read off the live
    // client instance rather than a constant.
    client.chat.completions.create = async () => makeStream(OK_CHUNKS);
    const response = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(response.resolvedEndpoint).toBe(
      "https://api.intelligence.io.solutions/api/v1",
    );
  });

  test("sends tool_choice auto when tools are offered without an explicit choice", async () => {
    // io.net defaults an unspecified tool_choice to "none" (not OpenAI's
    // "auto"), so the provider must send the explicit default or the model
    // could never invoke an offered tool.
    const provider = new IonetProvider(
      "test-key",
      "meta-llama/Llama-3.3-70B-Instruct",
    );
    const client = clientOf(provider);

    let seenParams:
      | {
          tools?: unknown;
          tool_choice?: unknown;
        }
      | undefined;
    client.chat.completions.create = async (params) => {
      seenParams = params as { tools?: unknown; tool_choice?: unknown };
      return makeStream(OK_CHUNKS);
    };
    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      {
        tools: [
          {
            name: "get_weather",
            description: "Get the weather",
            input_schema: { type: "object", properties: {} },
          },
        ],
      },
    );
    expect(Array.isArray(seenParams?.tools)).toBe(true);
    expect(seenParams?.tool_choice).toBe("auto");

    // An explicit caller choice still wins.
    let forcedParams: { tool_choice?: unknown } | undefined;
    client.chat.completions.create = async (params) => {
      forcedParams = params as { tool_choice?: unknown };
      return makeStream(OK_CHUNKS);
    };
    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      {
        tools: [
          {
            name: "get_weather",
            description: "Get the weather",
            input_schema: { type: "object", properties: {} },
          },
        ],
        config: { tool_choice: { type: "none" } },
      },
    );
    expect(forcedParams?.tool_choice).toBe("none");
  });

  test("honours an explicit baseURL override", async () => {
    const provider = new IonetProvider("test-key", "test-model", {
      baseURL: "https://inference.example.test/v1",
    });

    const client = clientOf(provider);
    expect(client.baseURL).toBe("https://inference.example.test/v1");

    client.chat.completions.create = async () => makeStream(OK_CHUNKS);
    const response = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(response.resolvedEndpoint).toBe("https://inference.example.test/v1");
  });
});
