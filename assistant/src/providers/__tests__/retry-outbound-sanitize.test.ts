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

  test("an inline base64 payload is passed through by reference, not scanned", async () => {
    const { provider, received } = capturingProvider();
    // Base64 is ASCII by construction; the guard must not walk a payload that
    // can run to a hundred megabytes. A deliberately corrupt payload proves
    // the field was skipped rather than scanned and found clean.
    const source = {
      type: "base64" as const,
      media_type: "image/png",
      data: `AAAA${LONE_HIGH}`,
    };
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image", source },
          { type: "text", text: `caption ${LONE_LOW}` },
        ],
      },
    ];

    await new RetryProvider(provider).sendMessage(messages);

    const sent = received();
    const image = sent.messages[0]!.content[0] as { source: unknown };
    expect(image.source).toBe(source);
    const text = sent.messages[0]!.content[1] as { text: string };
    expect(text.text).toBe("caption �");
  });

  test("token-count requests are sanitized the same way", async () => {
    let counted: {
      messages: Message[];
      systemPrompt: string;
      tools: unknown;
    } | null = null;
    const provider: Provider = {
      name: "anthropic",
      sendMessage: async () => OK_RESPONSE,
      countInputTokens: async (messages, systemPrompt, tools) => {
        counted = { messages, systemPrompt, tools };
        return 7;
      },
    };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: `count ${LONE_HIGH}` }] },
    ];

    const total = await new RetryProvider(provider).countInputTokens!(
      messages,
      `system ${LONE_LOW}`,
      undefined,
    );

    expect(total).toBe(7);
    const seen = counted!;
    const text = seen.messages[0]!.content[0] as { text: string };
    expect(text.text).toBe("count �");
    expect(seen.systemPrompt).toBe("system �");
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
