import { describe, expect, test } from "bun:test";

import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";

const DUMMY_MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

function makeResponse(): ProviderResponse {
  return {
    content: [{ type: "text", text: "ok" }],
    model: "gpt-5.4-mini",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

function makeProvider(
  name: string,
  onCall: (options: SendMessageOptions | undefined) => void,
): Provider {
  return {
    name,
    async sendMessage(_messages, _tools, _systemPrompt, options) {
      onCall(options);
      return makeResponse();
    },
  };
}

describe("OpenAI provider effort passthrough", () => {
  test("effort is preserved when passed to an OpenAI provider", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("openai", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { effort: "high" },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.effort).toBe("high");
  });

  test("effort is stripped for unsupported providers (e.g. ollama)", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("ollama", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { effort: "medium" },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.effort).toBeUndefined();
  });

  test("effort is stripped for fireworks provider", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("fireworks", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { effort: "low" },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.effort).toBeUndefined();
  });

  test("effort is preserved for anthropic provider", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("anthropic", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { effort: "high" },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.effort).toBe("high");
  });

  test("thinking is still stripped for OpenAI provider", async () => {
    let capturedOptions: SendMessageOptions | undefined;
    const inner = makeProvider("openai", (opts) => {
      capturedOptions = opts;
    });
    const retry = new RetryProvider(inner);

    await retry.sendMessage(DUMMY_MESSAGES, undefined, undefined, {
      config: { thinking: { enabled: true, budgetTokens: 10000 }, effort: "high" },
    });

    const config = capturedOptions?.config as Record<string, unknown>;
    expect(config.thinking).toBeUndefined();
    expect(config.effort).toBe("high");
  });
});
