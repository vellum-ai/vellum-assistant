/**
 * Serialization tests for capability-gated native audio input on
 * OpenAI-compatible providers: `file` blocks carrying eligible audio reach
 * audio-capable models (catalog `supportsAudioInput`, e.g. Inkling) as
 * `input_audio` content parts, while every other model keeps the
 * text-placeholder serialization byte-for-byte.
 */

import { describe, expect, test } from "bun:test";

import type { ContentBlock } from "../../types.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

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
      for (const c of chunks) yield c;
    },
  };
}

type CapturedParams = {
  messages: Array<{
    role: string;
    content: string | Array<Record<string, unknown>>;
  }>;
};

/** Swap `create` for a canned stream that records the request params. */
function stubCreateCapture(provider: OpenAIChatCompletionsProvider): {
  params: () => CapturedParams;
} {
  let captured: unknown;
  const inner = provider as unknown as {
    client: {
      chat: {
        completions: {
          create: (params: unknown) => Promise<AsyncIterable<MockChunk>>;
        };
      };
    };
  };
  inner.client.chat.completions.create = async (params) => {
    captured = params;
    return makeStream(OK_CHUNKS);
  };
  return { params: () => captured as CapturedParams };
}

// In the catalog with `supportsAudioInput: true` (Baseten's Inkling).
const AUDIO_MODEL = "thinkingmachines/inkling";
// Not in the catalog — must keep the text-placeholder serialization.
const TEXT_MODEL = "test-model";

function makeProvider(model: string): OpenAIChatCompletionsProvider {
  return new OpenAIChatCompletionsProvider("test-key", model, {
    providerName: "baseten",
    providerLabel: "Baseten",
  });
}

function audioFileBlock(mediaType: string, data = "QUJDRA=="): ContentBlock {
  return {
    type: "file",
    source: {
      type: "base64",
      media_type: mediaType,
      data,
      filename: "clip.audio",
    },
  };
}

function userContentParts(params: CapturedParams): Record<string, unknown>[] {
  return params.messages
    .filter((m) => m.role === "user" && Array.isArray(m.content))
    .flatMap((m) => m.content as Array<Record<string, unknown>>);
}

describe("chat-completions input_audio serialization", () => {
  test("wav file block on an audio-capable model becomes an input_audio part", async () => {
    const provider = makeProvider(AUDIO_MODEL);
    const captured = stubCreateCapture(provider);

    await provider.sendMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "can you hear this?" },
          audioFileBlock("audio/wav"),
        ],
      },
    ]);

    const parts = userContentParts(captured.params());
    expect(parts).toContainEqual({
      type: "input_audio",
      input_audio: { data: "QUJDRA==", format: "wav" },
    });
    expect(JSON.stringify(parts)).not.toContain("<attached_file");
  });

  test("mp3 mime maps onto the mp3 format enum", async () => {
    const provider = makeProvider(AUDIO_MODEL);
    const captured = stubCreateCapture(provider);

    await provider.sendMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "listen" },
          audioFileBlock("audio/mpeg"),
        ],
      },
    ]);

    const parts = userContentParts(captured.params());
    expect(parts).toContainEqual({
      type: "input_audio",
      input_audio: { data: "QUJDRA==", format: "mp3" },
    });
  });

  test("audio on a model without the capability keeps the text placeholder", async () => {
    const provider = makeProvider(TEXT_MODEL);
    const captured = stubCreateCapture(provider);

    await provider.sendMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "can you hear this?" },
          audioFileBlock("audio/wav"),
        ],
      },
    ]);

    const parts = userContentParts(captured.params());
    expect(JSON.stringify(parts)).not.toContain("input_audio");
    expect(parts).toContainEqual({
      type: "text",
      text: `<attached_file name="clip.audio" type="audio/wav" />\nNo extracted text available.`,
    });
  });

  test("oversize audio falls back to the text placeholder", async () => {
    const provider = makeProvider(AUDIO_MODEL);
    const captured = stubCreateCapture(provider);

    // ~12.75 MB decoded (> 12 MB inline cap) without being a real payload.
    const oversize = "A".repeat(17_000_000);
    await provider.sendMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "big one" },
          audioFileBlock("audio/wav", oversize),
        ],
      },
    ]);

    const parts = userContentParts(captured.params());
    expect(JSON.stringify(parts)).not.toContain("input_audio");
  });

  test("unsupported audio mime (m4a) falls back to the text placeholder", async () => {
    const provider = makeProvider(AUDIO_MODEL);
    const captured = stubCreateCapture(provider);

    await provider.sendMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "voice memo" },
          audioFileBlock("audio/x-m4a"),
        ],
      },
    ]);

    const parts = userContentParts(captured.params());
    expect(JSON.stringify(parts)).not.toContain("input_audio");
    expect(JSON.stringify(parts)).toContain("audio/x-m4a");
  });

  test("tool_result nested audio is hoisted into the trailing user message when capable", async () => {
    const provider = makeProvider(AUDIO_MODEL);
    const captured = stubCreateCapture(provider);

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "read the song file" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "file_read", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "read 4 bytes",
            contentBlocks: [audioFileBlock("audio/wav")],
          },
        ],
      },
    ]);

    const params = captured.params();
    const toolMessages = params.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(JSON.stringify(toolMessages)).not.toContain("input_audio");
    expect(userContentParts(params)).toContainEqual({
      type: "input_audio",
      input_audio: { data: "QUJDRA==", format: "wav" },
    });
  });

  test("tool_result nested audio stays dropped on a model without the capability", async () => {
    const provider = makeProvider(TEXT_MODEL);
    const captured = stubCreateCapture(provider);

    await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "read the song file" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "file_read", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "read 4 bytes",
            contentBlocks: [audioFileBlock("audio/wav")],
          },
        ],
      },
    ]);

    const serialized = JSON.stringify(captured.params());
    expect(serialized).not.toContain("input_audio");
    expect(serialized).not.toContain("QUJDRA==");
  });
});
