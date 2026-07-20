/**
 * Tests for the VoiceFrontDecider endpoint-decision service.
 *
 * The provider is injected via the `getProvider` seam (live-voice DI
 * convention), so no module mocking is needed. The tests pin the fail-open
 * contract: every failure mode (null provider, timeout, thrown error, caller
 * abort) resolves to "release" within the configured budget.
 */

import { describe, expect, test } from "bun:test";

import { LiveVoiceFrontModelConfigSchema } from "../../config/schemas/live-voice.js";
import type { Provider, ProviderResponse } from "../../providers/types.js";
import {
  createVoiceFrontDecider,
  type VoiceAckTextInput,
  type VoiceEndpointDecisionInput,
} from "../front-decision.js";

const config = LiveVoiceFrontModelConfigSchema.parse({});

const input: VoiceEndpointDecisionInput = {
  transcriptSoFar: "so what I was thinking is",
  latestPartial: null,
  silenceThresholdMs: 1200,
  extensionCount: 0,
};

function stubProvider(sendMessage: Provider["sendMessage"]): Provider {
  return { name: "stub", sendMessage };
}

function toolResponse(
  inputBlock: Record<string, unknown>,
  name = "ack",
): ProviderResponse {
  return {
    content: [{ type: "tool_use", id: "tu_1", name, input: inputBlock }],
    model: "stub-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "tool_use",
  };
}

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "stub-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

describe("createVoiceFrontDecider — decideEndpoint", () => {
  test('answer "0" → hold', async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () => stubProvider(async () => textResponse("0")),
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "hold" });
  });

  test('answer "1" → release', async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () => stubProvider(async () => textResponse("1")),
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
  });

  test('answer "0" with trailing delimiter → hold', async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () => stubProvider(async () => textResponse(" 0\n")),
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "hold" });
  });

  test("sends transcript, tight token budget, no tools, and call-site config", async () => {
    let captured: Parameters<Provider["sendMessage"]> | undefined;
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async (...args) => {
          captured = args;
          return textResponse("1");
        }),
    });
    await decider.decideEndpoint({ ...input, latestPartial: "and then" });

    const [messages, options] = captured!;
    expect(messages).toHaveLength(1);
    const text = (messages[0].content[0] as { text: string }).text;
    expect(text).toContain("so what I was thinking is");
    expect(text).toContain("and then");
    expect(options?.config).toMatchObject({
      max_tokens: 4,
      callSite: "voiceFrontDecision",
      disableCache: true,
    });
    // Single-token text protocol: no tool schema in the prompt, no forced
    // tool call in the output — the latency-critical path stays minimal.
    expect(options?.tools).toBeUndefined();
    expect(options?.config?.tool_choice).toBeUndefined();
    expect(options?.systemPrompt).toContain("finished");
  });

  test("null provider → release (fail-open)", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () => null,
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
  });

  test("provider resolution throws → release", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () => {
        throw new Error("resolution boom");
      },
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
  });

  test("getProvider that never resolves → release after endpointDecisionTimeoutMs", async () => {
    const decider = createVoiceFrontDecider({
      config: LiveVoiceFrontModelConfigSchema.parse({
        endpointDecisionTimeoutMs: 20,
      }),
      // Stalled lazy provider initialization — the timeout must bound the
      // whole call including resolution, not just sendMessage.
      getProvider: () => new Promise<Provider | null>(() => {}),
    });
    const start = Date.now();
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("sendMessage that never resolves → release after endpointDecisionTimeoutMs", async () => {
    const decider = createVoiceFrontDecider({
      config: LiveVoiceFrontModelConfigSchema.parse({
        endpointDecisionTimeoutMs: 20,
      }),
      // Never settles and ignores the abort signal entirely — the decider's
      // own timeout race must still bound the call.
      getProvider: async () =>
        stubProvider(() => new Promise<ProviderResponse>(() => {})),
    });
    const start = Date.now();
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("sendMessage throws → release", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () => {
          throw new Error("provider boom");
        }),
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
  });

  test("caller-signal abort → release promptly", async () => {
    const decider = createVoiceFrontDecider({
      // Long timeout so only the caller's abort can end the call early.
      config: LiveVoiceFrontModelConfigSchema.parse({
        endpointDecisionTimeoutMs: 60_000,
      }),
      getProvider: async () =>
        stubProvider(() => new Promise<ProviderResponse>(() => {})),
    });
    const controller = new AbortController();
    const pending = decider.decideEndpoint(input, controller.signal);
    controller.abort();
    const start = Date.now();
    expect(await pending).toEqual({ action: "release" });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("response without a text block → release", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () => toolResponse({ complete: false })),
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
  });

  test("empty text answer → release", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () => stubProvider(async () => textResponse("   ")),
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
  });

  test("non-protocol prose answer → release (fail-open)", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () => textResponse("The speaker seems unsure")),
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
  });

  test('prose starting with "0" (truncated label echo) → release', async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () => textResponse("0 if the speaker")),
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
  });
});

describe("createVoiceFrontDecider — generateAckText", () => {
  const ackInput: VoiceAckTextInput = {
    transcriptSoFar: "can you check my calendar for tomorrow",
  };

  test("generated text returned in time → trimmed text", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () =>
          toolResponse({ ack: "  Sure, give me a second.  " }, "ack"),
        ),
    });
    expect(await decider.generateAckText(ackInput)).toBe(
      "Sure, give me a second.",
    );
  });

  test("sends transcript + tool name, forced ack tool, and call-site config", async () => {
    let captured: Parameters<Provider["sendMessage"]> | undefined;
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async (...args) => {
          captured = args;
          return toolResponse({ ack: "On it." }, "ack");
        }),
    });
    await decider.generateAckText({ ...ackInput, toolName: "web_search" });

    const [messages, options] = captured!;
    expect(messages).toHaveLength(1);
    const text = (messages[0].content[0] as { text: string }).text;
    expect(text).toContain("can you check my calendar for tomorrow");
    expect(text).toContain("web_search");
    expect(options?.config).toMatchObject({
      max_tokens: 64,
      callSite: "voiceFrontDecision",
      tool_choice: { type: "tool", name: "ack" },
      disableCache: true,
    });
    expect(options?.tools?.map((t) => t.name)).toEqual(["ack"]);
    // The prompt constrains the ack to acknowledgment-only: the brain owns
    // all content.
    expect(options?.systemPrompt).toContain("without answering");
    expect(options?.systemPrompt).toContain("no facts");
  });

  test("null provider → null", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () => null,
    });
    expect(await decider.generateAckText(ackInput)).toBeNull();
  });

  test("provider resolution throws → null", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () => {
        throw new Error("resolution boom");
      },
    });
    expect(await decider.generateAckText(ackInput)).toBeNull();
  });

  test("getProvider that never resolves → null after ackGenerationTimeoutMs", async () => {
    const decider = createVoiceFrontDecider({
      config: LiveVoiceFrontModelConfigSchema.parse({
        ackGenerationTimeoutMs: 20,
      }),
      // Stalled lazy provider initialization — the timeout must bound the
      // whole call including resolution, not just sendMessage.
      getProvider: () => new Promise<Provider | null>(() => {}),
    });
    const start = Date.now();
    expect(await decider.generateAckText(ackInput)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("sendMessage that never resolves → null after ackGenerationTimeoutMs", async () => {
    const decider = createVoiceFrontDecider({
      config: LiveVoiceFrontModelConfigSchema.parse({
        ackGenerationTimeoutMs: 20,
      }),
      // Never settles and ignores the abort signal entirely — the decider's
      // own timeout race must still bound the call.
      getProvider: async () =>
        stubProvider(() => new Promise<ProviderResponse>(() => {})),
    });
    const start = Date.now();
    expect(await decider.generateAckText(ackInput)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("sendMessage throws → null", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () => {
          throw new Error("provider boom");
        }),
    });
    expect(await decider.generateAckText(ackInput)).toBeNull();
  });

  test("caller-signal abort → null promptly", async () => {
    const decider = createVoiceFrontDecider({
      // Long timeout so only the caller's abort can end the call early.
      config: LiveVoiceFrontModelConfigSchema.parse({
        ackGenerationTimeoutMs: 60_000,
      }),
      getProvider: async () =>
        stubProvider(() => new Promise<ProviderResponse>(() => {})),
    });
    const controller = new AbortController();
    const pending = decider.generateAckText(ackInput, controller.signal);
    controller.abort();
    const start = Date.now();
    expect(await pending).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("empty/whitespace ack → null", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () => toolResponse({ ack: "   " }, "ack")),
    });
    expect(await decider.generateAckText(ackInput)).toBeNull();
  });

  test("overlong ack (> 120 chars) → null", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () => toolResponse({ ack: "x".repeat(121) }, "ack")),
    });
    expect(await decider.generateAckText(ackInput)).toBeNull();
  });

  test("missing/foreign tool block → null", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () => toolResponse({ ack: "Hi." }, "other_tool")),
    });
    expect(await decider.generateAckText(ackInput)).toBeNull();
  });

  test("malformed tool input (ack not a string) → null", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () => toolResponse({ ack: 42 }, "ack")),
    });
    expect(await decider.generateAckText(ackInput)).toBeNull();
  });
});
