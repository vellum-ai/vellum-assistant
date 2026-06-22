/**
 * End-to-end integration test: drives the REAL agent loop with all first-party
 * defaults registered (so the advisor plugin's hooks + tool are live), and lets
 * the REAL consult run. Only the provider boundary is stubbed:
 *   - the executor's provider (a scripted mock provider), and
 *   - `getConfiguredProvider`, so the advisor sub-call resolves to a second
 *     scripted mock provider instead of a configured one.
 *
 * The advisor's inference genuinely runs through `consult` → `sendMessage`
 * against the injected advisor provider, exercising the full hook-capture →
 * tool.execute → consult → routed-inference path through the loop.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  createMockProvider,
  textResponse,
} from "../../../../__tests__/helpers/mock-provider.js";
import { AgentLoop } from "../../../../agent/loop.js";
import type {
  ContentBlock,
  Message,
  ProviderResponse,
} from "../../../../providers/types.js";

const ADVICE = "ADVICE: use a channel-based worker pool with graceful drain.";
let advisorProvider: ReturnType<typeof createMockProvider> | null = null;

const realProviderSendMessage =
  await import("../../../../providers/provider-send-message.js");
mock.module("../../../../providers/provider-send-message.js", () => ({
  ...realProviderSendMessage,
  getConfiguredProvider: async () => advisorProvider?.provider ?? null,
}));

const { resetPluginRegistryAndRegisterDefaults } =
  await import("../../index.js");
const advisorTool = (await import("../tools/advisor.js")).default;

const userTurn: Message = {
  role: "user",
  content: [{ type: "text", text: "build a worker pool" }],
};

function textOf(content: ReadonlyArray<ContentBlock>): string {
  return content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

describe("advisor — agent-loop integration", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
    advisorProvider = createMockProvider([textResponse(ADVICE)]);
  });

  test("model calls advisor → hooks capture → consult routes through inference → advice returns", async () => {
    const consultThenText: ProviderResponse = {
      content: [
        { type: "text", text: "Let me consult the advisor." },
        { type: "tool_use", id: "call-1", name: "advisor", input: {} },
      ],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "tool_use",
    };
    const { provider } = createMockProvider([
      consultThenText,
      textResponse("Done — implemented the worker pool."),
    ]);

    const conversationId = "advisor-itest";
    const loop = new AgentLoop({
      provider,
      systemPrompt: "You are a coding agent.",
      conversationId,
      tools: [
        {
          name: "advisor",
          description: "",
          input_schema: { type: "object", properties: {} },
        },
      ],
      toolExecutor: async (name, input) =>
        name === "advisor"
          ? advisorTool.execute!(input, { conversationId } as never)
          : { content: `unknown tool ${name}`, isError: true },
    });

    const { history } = await loop.run({
      requestId: "req-1",
      messages: [userTurn],
      onEvent: () => {},
      callSite: "mainAgent",
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // The advisor sub-call happened, routed through the dedicated advisor call site.
    expect(advisorProvider!.calls).toHaveLength(1);
    const sub = advisorProvider!.calls[0];
    expect(sub.options?.config?.callSite).toBe("advisor");
    // No `advisorProfile` configured in the default test config, so no override
    // is passed and the `advisor` call site resolves its own default profile.
    expect(sub.options?.config?.overrideProfile).toBeUndefined();
    expect(sub.options?.config?.tool_choice).toEqual({ type: "none" });
    // No advisor-specific output cap — the resolver applies the profile budget.
    expect(sub.options?.config?.max_tokens).toBeUndefined();

    // The advisor saw the captured transcript (task present; pending tool_use stripped).
    expect(textOf(sub.messages[0].content)).toContain("build a worker pool");
    expect(textOf(sub.messages[sub.messages.length - 1].content)).toContain(
      "focused strategic guidance",
    );
    // It also saw the model's CURRENT turn — the text it wrote right before the
    // `advisor` tool_use — which `post-model-call` lifts out of `ctx.content`.
    const transcript = sub.messages.map((m) => textOf(m.content)).join("\n");
    expect(transcript).toContain("Let me consult the advisor.");

    // The advisor saw the executor's system prompt (via pre-model-call).
    expect(sub.options?.systemPrompt).toContain("senior advisor");
    expect(sub.options?.systemPrompt).toContain("You are a coding agent.");

    // The advice flowed back into the executor's history as the tool result.
    const toolResult = history
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    expect((toolResult as { content: string }).content).toContain(
      "channel-based worker pool",
    );

    // The loop completed with the final answer.
    const lastAssistant = [...history]
      .reverse()
      .find((m) => m.role === "assistant")!;
    expect(textOf(lastAssistant.content)).toContain(
      "implemented the worker pool",
    );
  });
});
