import { describe, expect, test } from "bun:test";

import type { Message } from "../../types.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

type MockChunk = {
  choices: Array<{ delta: { content?: string }; finish_reason?: string }>;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

function makeStream(chunks: MockChunk[]): AsyncIterable<MockChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield c;
      }
    },
  };
}

function stubProvider(model: string): {
  provider: OpenAIChatCompletionsProvider;
  requests: Array<{ messages: unknown[] }>;
} {
  const provider = new OpenAIChatCompletionsProvider("test-key", model);
  const requests: Array<{ messages: unknown[] }> = [];
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (params: { messages: unknown[] }) => {
          requests.push(params);
          return makeStream([
            {
              choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
              model,
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          ]);
        },
      },
    },
  };
  return { provider, requests };
}

const IMAGE_DATA = "aGVsbG8taW1hZ2UtYnl0ZXM=";

const userMessageWithImage = (): Message[] => [
  {
    role: "user",
    content: [
      { type: "text", text: "what is in this screenshot?" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: IMAGE_DATA,
        },
      },
    ],
  },
];

const toolResultWithImage = (): Message[] => [
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "tu_1", name: "screenshot", input: {} }],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "captured",
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: IMAGE_DATA,
            },
          },
        ],
      },
    ],
  },
];

// A model the catalog explicitly marks `supportsVision: false` rejects the
// whole request over a single image block (HTTP 400) — image blocks can reach
// it through persisted history (compaction-rebuilt context, profile switch),
// so the provider serializes them as text placeholders instead. Models the
// catalog doesn't know keep their images: the provider decides.
describe("chat-completions image input gate", () => {
  // Catalog: supportsVision: false.
  const TEXT_ONLY_MODEL = "accounts/fireworks/models/glm-5p2";
  // Catalog: supportsVision: true.
  const VISION_MODEL = "accounts/fireworks/models/kimi-k2p6";

  test("catalog text-only model: user-message image becomes a text placeholder", async () => {
    const { provider, requests } = stubProvider(TEXT_ONLY_MODEL);
    await provider.sendMessage(userMessageWithImage());

    const wire = JSON.stringify(requests[0].messages);
    expect(wire).not.toContain("image_url");
    expect(wire).not.toContain(IMAGE_DATA);
    expect(wire).toContain(
      "[Image omitted: this model does not accept image input]",
    );
  });

  test("catalog text-only model: tool-result image becomes a text placeholder", async () => {
    const { provider, requests } = stubProvider(TEXT_ONLY_MODEL);
    await provider.sendMessage(toolResultWithImage());

    const wire = JSON.stringify(requests[0].messages);
    expect(wire).not.toContain("image_url");
    expect(wire).not.toContain(IMAGE_DATA);
    expect(wire).toContain(
      "[Image omitted: this model does not accept image input]",
    );
  });

  test("catalog vision model: image is sent as image_url", async () => {
    const { provider, requests } = stubProvider(VISION_MODEL);
    await provider.sendMessage(userMessageWithImage());

    const wire = JSON.stringify(requests[0].messages);
    expect(wire).toContain("image_url");
    expect(wire).toContain(IMAGE_DATA);
  });

  test("model unknown to the catalog: image is sent as image_url (fail open)", async () => {
    const { provider, requests } = stubProvider("some-uncataloged-model");
    await provider.sendMessage(userMessageWithImage());

    const wire = JSON.stringify(requests[0].messages);
    expect(wire).toContain("image_url");
    expect(wire).toContain(IMAGE_DATA);
  });

  test("per-call model override drives the gate", async () => {
    // Provider constructed with a vision model, but the call overrides to a
    // text-only model — the override is what goes on the wire, so it decides.
    const { provider, requests } = stubProvider(VISION_MODEL);
    await provider.sendMessage(userMessageWithImage(), {
      config: { model: TEXT_ONLY_MODEL },
    } as never);

    const wire = JSON.stringify(requests[0].messages);
    expect(wire).not.toContain("image_url");
    expect(wire).toContain(
      "[Image omitted: this model does not accept image input]",
    );
  });
});
