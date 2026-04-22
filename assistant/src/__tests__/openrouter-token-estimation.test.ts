import { describe, expect, test } from "bun:test";

import { estimatePromptTokens } from "../context/token-estimator.js";
import { OpenRouterProvider } from "../providers/openrouter/client.js";
import type { Message } from "../providers/types.js";

/** Build a minimal valid PNG header encoding the given dimensions. */
function makePngBase64(
  width: number,
  height: number,
  paddingBytes = 0,
): string {
  const header = Buffer.alloc(24);
  header[0] = 0x89;
  header[1] = 0x50;
  header[2] = 0x4e;
  header[3] = 0x47;
  header[4] = 0x0d;
  header[5] = 0x0a;
  header[6] = 0x1a;
  header[7] = 0x0a;
  header.writeUInt32BE(13, 8);
  header[12] = 0x49;
  header[13] = 0x48;
  header[14] = 0x44;
  header[15] = 0x52;
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  const padding = Buffer.alloc(paddingBytes, 0x42);
  return Buffer.concat([header, padding]).toString("base64");
}

describe("OpenRouterProvider token estimation routing", () => {
  test("reports 'anthropic' for anthropic/* default models", () => {
    const provider = new OpenRouterProvider(
      "fake-key",
      "anthropic/claude-opus-4-6",
    );
    expect(provider.tokenEstimationProvider).toBe("anthropic");
  });

  test("reports its own name for non-Anthropic default models", () => {
    const provider = new OpenRouterProvider("fake-key", "x-ai/grok-4.20-beta");
    expect(provider.tokenEstimationProvider).toBe(provider.name);
    expect(provider.tokenEstimationProvider).toBe("openrouter");
  });

  test("estimatePromptTokens applies Anthropic image scaling when routed via OpenRouter", () => {
    const provider = new OpenRouterProvider(
      "fake-key",
      "anthropic/claude-opus-4-6",
    );
    // 1920x1080 screenshot with ~200 KB of pixel data → base64/4 would be ~65k
    // tokens; dimension-based Anthropic rules land around 1.6k tokens.
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: makePngBase64(1920, 1080, 200_000),
            },
          },
        ],
      },
    ];

    const estimated = estimatePromptTokens(messages, "system", {
      providerName: provider.tokenEstimationProvider,
    });

    // Dimension-based estimate should be well under 5k; base64/4 would exceed 50k.
    expect(estimated).toBeLessThan(5_000);
  });

  test("estimatePromptTokens falls back to base64/4 for non-Anthropic OpenRouter models", () => {
    const provider = new OpenRouterProvider("fake-key", "x-ai/grok-4.20-beta");
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: makePngBase64(1920, 1080, 200_000),
            },
          },
        ],
      },
    ];

    const estimated = estimatePromptTokens(messages, "system", {
      providerName: provider.tokenEstimationProvider,
    });

    // Base64/4 heuristic on ~200 KB of image data → far more than 10k tokens.
    expect(estimated).toBeGreaterThan(50_000);
  });
});
