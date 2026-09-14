/**
 * `RetryProvider` strips orphaned UTF-16 surrogates from every outbound
 * request before the inner adapter sees it. An orphan (half of a surrogate
 * pair left by a code-unit `.slice()`) serializes to a `\udXXX` escape that
 * strict provider parsers reject with a 400, so the guard sits at the one
 * layer every adapter shares instead of inside each client.
 */

import { describe, expect, test } from "bun:test";

import { stripOrphanedSurrogates } from "../../util/unicode.js";
import { RetryProvider } from "../retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

const OK_RESPONSE = {
  content: [{ type: "text", text: "ok" }],
  model: "test-model",
  usage: { inputTokens: 1, outputTokens: 1 },
} as unknown as ProviderResponse;

const LONE_HIGH = "\uD83C";
const LONE_LOW = "\uDF89";
const EMOJI = "🎉";

function capturingProvider(): {
  provider: Provider;
  received: () => { messages: Message[]; options?: SendMessageOptions };
} {
  let captured: { messages: Message[]; options?: SendMessageOptions } | null =
    null;
  const provider: Provider = {
    name: "openai",
    sendMessage: async (messages, options) => {
      captured = { messages, options };
      return OK_RESPONSE;
    },
  };
  return {
    provider,
    received: () => {
      if (!captured) {
        throw new Error("inner provider was not called");
      }
      return captured;
    },
  };
}

describe("RetryProvider outbound surrogate sanitization", () => {
  test("an orphaned surrogate in a text block, a tool result, the system prompt, and a tool description never reaches the inner adapter", async () => {
    const { provider, received } = capturingProvider();
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: `memory preview ${LONE_HIGH} cut` }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: `shell output ${LONE_LOW} more`,
          },
        ],
      },
    ];

    await new RetryProvider(provider).sendMessage(messages, {
      systemPrompt: `system ${LONE_HIGH}`,
      tools: [
        {
          name: "select_pages",
          description: `pick ${LONE_LOW}`,
          input_schema: { type: "object", properties: {} },
        },
      ],
    });

    const sent = received();
    expect(stripOrphanedSurrogates(JSON.stringify(sent.messages))).toBe(
      JSON.stringify(sent.messages),
    );
    const systemPrompt = sent.options?.systemPrompt ?? "";
    expect(stripOrphanedSurrogates(systemPrompt)).toBe(systemPrompt);
    expect(stripOrphanedSurrogates(JSON.stringify(sent.options?.tools))).toBe(
      JSON.stringify(sent.options?.tools),
    );
    // The orphan is replaced, not dropped, so surrounding text survives.
    const text = sent.messages[0]!.content[0] as { text: string };
    expect(text.text).toBe("memory preview � cut");
  });

  test("a well-formed request passes through by reference, emoji intact", async () => {
    const { provider, received } = capturingProvider();
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: `hello ${EMOJI}` }] },
    ];

    await new RetryProvider(provider).sendMessage(messages);

    const sent = received();
    expect(sent.messages).toBe(messages);
    const text = sent.messages[0]!.content[0] as { text: string };
    expect(text.text).toContain(EMOJI);
  });
});
