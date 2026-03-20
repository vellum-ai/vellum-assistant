import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import { FailoverProvider } from "../providers/failover.js";
import type {
  Message,
  Provider,
  ProviderResponse,
} from "../providers/types.js";
import { ProviderError } from "../util/errors.js";

const MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "Hello" }] },
];

function successResponse(
  overrides?: Partial<ProviderResponse>,
): ProviderResponse {
  return {
    content: [{ type: "text", text: "ok" }],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
    ...overrides,
  };
}

describe("FailoverProvider actual provider propagation", () => {
  test("stamps the winning provider when failover uses a fallback", async () => {
    const primary: Provider = {
      name: "openrouter",
      async sendMessage() {
        throw new ProviderError("down", "openrouter", 500);
      },
    };
    const secondary: Provider = {
      name: "fireworks",
      async sendMessage() {
        return successResponse();
      },
    };

    const provider = new FailoverProvider([primary, secondary]);
    const response = await provider.sendMessage(MESSAGES);

    expect(response.actualProvider).toBe("fireworks");
  });

  test("preserves an inner provider's actual provider when already set", async () => {
    const inner: Provider = {
      name: "retry-wrapper",
      async sendMessage() {
        return successResponse({ actualProvider: "anthropic" });
      },
    };

    const provider = new FailoverProvider([inner]);
    const response = await provider.sendMessage(MESSAGES);

    expect(response.actualProvider).toBe("anthropic");
  });
});
