import { describe, expect, test } from "bun:test";

import { OpenAIResponsesProvider } from "../responses-provider.js";

interface ResponsesStreamEvent {
  type: string;
  response?: { model?: string; status?: string };
}

function makeStream(
  events: ResponsesStreamEvent[],
): AsyncIterable<ResponsesStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

/**
 * Construct a provider with its private `client.responses.create` swapped for a
 * stub that captures the request params and returns a minimal completed stream
 * so `sendMessage` resolves cleanly.
 */
function stubProvider(): {
  provider: OpenAIResponsesProvider;
  requests: Record<string, unknown>[];
} {
  const provider = new OpenAIResponsesProvider("test-key", "test-model");
  const requests: Record<string, unknown>[] = [];
  (provider as unknown as { client: unknown }).client = {
    responses: {
      create: async (params: Record<string, unknown>) => {
        requests.push(params);
        return makeStream([
          {
            type: "response.completed",
            response: { model: "test-model", status: "completed" },
          },
        ]);
      },
    },
  };
  return { provider, requests };
}

describe("OpenAIResponsesProvider top_p forwarding", () => {
  test("forwards config.top_p onto the Responses request params", async () => {
    const { provider, requests } = stubProvider();

    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { top_p: 0.9 } },
    );

    const params = requests[0] as { top_p?: number };
    expect(params.top_p).toBe(0.9);
  });

  test("omits top_p from the Responses request params when not configured", async () => {
    const { provider, requests } = stubProvider();

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    const params = requests[0] as { top_p?: number };
    expect(params.top_p).toBeUndefined();
  });

  test("omits top_p on reasoning requests even when configured", async () => {
    const { provider, requests } = stubProvider();

    // `effort: "high"` maps to a reasoning.effort via EFFORT_TO_REASONING_EFFORT,
    // so `params.reasoning` is set. Reasoning models reject sampling params, so
    // top_p must not be forwarded.
    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { top_p: 0.9, effort: "high" } },
    );

    const params = requests[0] as { top_p?: number; reasoning?: unknown };
    expect(params.reasoning).toBeDefined();
    expect(params.top_p).toBeUndefined();
  });
});
