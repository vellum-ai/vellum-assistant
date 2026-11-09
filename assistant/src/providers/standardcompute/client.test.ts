/**
 * Verifies the Standard Compute provider wiring: the SDK client must resolve
 * to the documented Standard Compute endpoint unless an explicit override is
 * supplied (custom-connection / test usage).
 */

import { describe, expect, test } from "bun:test";

import { StandardComputeProvider } from "./client.js";

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

function clientOf(provider: StandardComputeProvider) {
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

describe("StandardComputeProvider", () => {
  test("defaults the SDK client to the Standard Compute endpoint", async () => {
    const provider = new StandardComputeProvider("test-key", "StandardCompute");

    const client = clientOf(provider);
    expect(client.baseURL).toBe("https://api.stdcmpt.com/v1");

    let seenModel: unknown;
    client.chat.completions.create = async (params) => {
      seenModel = (params as { model?: unknown }).model;
      return makeStream(OK_CHUNKS);
    };
    const response = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(seenModel).toBe("StandardCompute");
    expect(response.resolvedEndpoint).toBe("https://api.stdcmpt.com/v1");
  });

  test("honours an explicit baseURL override", async () => {
    const provider = new StandardComputeProvider("test-key", "test-model", {
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
