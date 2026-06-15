import { describe, expect, test } from "bun:test";

import { FireworksProvider } from "../client.js";

type MockChunk = {
  choices: Array<{
    delta: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

function stubFireworks(model: string): {
  provider: FireworksProvider;
  requests: Array<Record<string, unknown>>;
} {
  const provider = new FireworksProvider("test-key", model);
  const requests: Array<Record<string, unknown>> = [];
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          requests.push(params);
          const chunks: MockChunk[] = [
            {
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          ];
          return {
            async *[Symbol.asyncIterator]() {
              for (const c of chunks) yield c;
            },
          };
        },
      },
    },
  };
  return { provider, requests };
}

async function send(provider: FireworksProvider): Promise<void> {
  await provider.sendMessage([
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ]);
}

describe("FireworksProvider reasoning_split", () => {
  test("sends reasoning_split for MiniMax models so thinking lands in reasoning_content", async () => {
    const { provider, requests } = stubFireworks(
      "accounts/fireworks/models/minimax-m3",
    );
    await send(provider);
    expect(requests[0].reasoning_split).toBe(true);
  });

  test("omits reasoning_split for non-MiniMax models", async () => {
    const { provider, requests } = stubFireworks(
      "accounts/fireworks/models/deepseek-v4",
    );
    await send(provider);
    expect(requests[0].reasoning_split).toBeUndefined();
  });
});
