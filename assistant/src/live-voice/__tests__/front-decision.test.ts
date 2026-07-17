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
  name = "turn_decision",
): ProviderResponse {
  return {
    content: [{ type: "tool_use", id: "tu_1", name, input: inputBlock }],
    model: "stub-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "tool_use",
  };
}

describe("createVoiceFrontDecider — decideEndpoint", () => {
  test("tool result complete:false → hold", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () => toolResponse({ complete: false })),
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "hold" });
  });

  test("tool result complete:true → release", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () => toolResponse({ complete: true })),
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
  });

  test("sends transcript, forced turn_decision tool, and call-site config", async () => {
    let captured: Parameters<Provider["sendMessage"]> | undefined;
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async (...args) => {
          captured = args;
          return toolResponse({ complete: true });
        }),
    });
    await decider.decideEndpoint({ ...input, latestPartial: "and then" });

    const [messages, options] = captured!;
    expect(messages).toHaveLength(1);
    const text = (messages[0].content[0] as { text: string }).text;
    expect(text).toContain("so what I was thinking is");
    expect(text).toContain("and then");
    expect(options?.config).toMatchObject({
      max_tokens: 64,
      callSite: "voiceFrontDecision",
      tool_choice: { type: "tool", name: "turn_decision" },
      disableCache: true,
    });
    expect(options?.tools?.map((t) => t.name)).toEqual(["turn_decision"]);
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

  test("missing/foreign tool block → release", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () =>
        stubProvider(async () =>
          toolResponse({ complete: false }, "some_other_tool"),
        ),
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
  });

  test("malformed tool input (complete not boolean) → release", async () => {
    const decider = createVoiceFrontDecider({
      config,
      getProvider: async () => stubProvider(async () => toolResponse({})),
    });
    expect(await decider.decideEndpoint(input)).toEqual({ action: "release" });
  });
});
