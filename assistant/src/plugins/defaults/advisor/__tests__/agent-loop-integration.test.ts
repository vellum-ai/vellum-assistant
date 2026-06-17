/**
 * End-to-end integration test: drives the REAL agent loop with all first-party
 * defaults registered (so the advisor plugin's hooks + tool are live), and lets
 * the REAL consult run. Only two boundaries are stubbed:
 *   - the executor's provider HTTP boundary (a scripted mock provider), and
 *   - `getConfiguredProvider`, so the advisor sub-call resolves to a second
 *     scripted mock provider instead of a configured one.
 *
 * `runBtwSidechain` itself is NOT mocked — the advisor's inference genuinely
 * runs through it against the injected advisor provider, exercising the full
 * hook-capture → tool.execute → consult → routed-inference path through the
 * loop, the way a live turn would (minus real model calls).
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

// ── Stub the advisor sub-call's provider resolution ─────────────────────────
const ADVICE = "ADVICE: use a channel-based worker pool with graceful drain.";
let advisorProvider: ReturnType<typeof createMockProvider> | null = null;

// Import the real module first, then re-export it with only
// `getConfiguredProvider` overridden, so every other export the loop and the
// real `runBtwSidechain` rely on (userMessage, extractAllText, createTimeout…)
// keeps working.
const realProviderSendMessage =
  await import("../../../../providers/provider-send-message.js");
mock.module("../../../../providers/provider-send-message.js", () => ({
  ...realProviderSendMessage,
  getConfiguredProvider: async () => advisorProvider?.provider ?? null,
}));

// Imported AFTER the mock so the advisor plugin's `consult.ts` binds the
// stubbed `getConfiguredProvider`.
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

  test("model calls advisor → hooks capture the transcript → consult routes through Vellum → advice returns", async () => {
    // The executor turn: emit some text, then call the no-arg advisor tool;
    // after the tool result comes back, end with a final answer.
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
      // The loop only needs the provider-facing shape; execution is dispatched
      // to the real `advisorTool.execute` via `toolExecutor` below.
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
      callSite: "mainAgent", // advisor hooks gate on this
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // ── The advisor sub-call genuinely happened, routed through Vellum ──
    expect(advisorProvider!.calls).toHaveLength(1);
    const sub = advisorProvider!.calls[0];
    expect(sub.options?.config?.callSite).toBe("advisor"); // dedicated call site
    expect(sub.options?.tools).toEqual([]); // advisor runs tool-less
    expect(sub.options?.config?.max_tokens).toBe(2048); // output cap

    // ── The advisor saw the captured transcript (via the real post-model-call
    //    hook through the loop), with the pending advisor tool_use stripped ──
    expect(textOf(sub.messages[0].content)).toContain("build a worker pool");
    expect(textOf(sub.messages[sub.messages.length - 1].content)).toContain(
      "80 words",
    ); // the word-limit nudge
    const advisorTranscript = sub.messages
      .map((m) => textOf(m.content))
      .join("\n");
    expect(advisorTranscript).not.toContain("call-1"); // no dangling tool_use leaked

    // ── The advisor saw the executor's system prompt (via pre-model-call) ──
    expect(sub.systemPrompt).toContain("senior technical advisor");
    expect(sub.systemPrompt).toContain("You are a coding agent.");

    // ── The advice flowed back into the executor's history as the tool result ──
    const toolResult = history
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect((toolResult as { content: string }).content).toContain(
      "channel-based worker pool",
    );

    // ── The loop completed with the final answer ──
    const lastAssistant = [...history]
      .reverse()
      .find((m) => m.role === "assistant")!;
    expect(textOf(lastAssistant.content)).toContain(
      "implemented the worker pool",
    );
  });

  test("with no advisor provider resolvable, the tool soft-fails and the turn still completes", async () => {
    advisorProvider = null; // getConfiguredProvider("advisor") → null

    const consultThenText: ProviderResponse = {
      content: [{ type: "tool_use", id: "call-1", name: "advisor", input: {} }],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "tool_use",
    };
    const { provider } = createMockProvider([
      consultThenText,
      textResponse("Proceeding without advice."),
    ]);

    const conversationId = "advisor-itest-soft";
    const loop = new AgentLoop({
      provider,
      systemPrompt: "You are a coding agent.",
      conversationId,
      // The loop only needs the provider-facing shape; execution is dispatched
      // to the real `advisorTool.execute` via `toolExecutor` below.
      tools: [
        {
          name: "advisor",
          description: "",
          input_schema: { type: "object", properties: {} },
        },
      ],
      toolExecutor: async (name, input) =>
        advisorTool.execute!(input, { conversationId } as never),
    });

    const { history } = await loop.run({
      requestId: "req-2",
      messages: [userTurn],
      onEvent: () => {},
      callSite: "mainAgent",
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // The advisor tool returned a benign (non-error) result...
    const toolResult = history
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result") as
      | { content: string; is_error?: boolean }
      | undefined;
    expect(toolResult?.content).toContain("advisor unavailable");
    // ...and the turn still ran to a clean end on the follow-up answer.
    const lastAssistant = [...history]
      .reverse()
      .find((m) => m.role === "assistant")!;
    expect(textOf(lastAssistant.content)).toContain(
      "Proceeding without advice",
    );
  });
});
