/**
 * Tests for the `pre-model-call` and `assistant-message` plugin hooks: a plugin
 * can edit the outbound request, transform the finalized assistant message
 * (persisted + streamed), and defer the live stream so the transformed text is
 * emitted once. All hooks here use neutral transforms (redaction / uppercasing).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type {
  AssistantMessageContext,
  PreModelCallContext,
} from "../plugin-api/types.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import { registerPlugin } from "../plugins/registry.js";
import type {
  ContentBlock,
  Message,
  ProviderResponse,
} from "../providers/types.js";
import { createMockProvider, textResponse } from "./helpers/mock-provider.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "Hello" }],
};

function collect(events: AgentEvent[]): (event: AgentEvent) => void {
  return (event) => events.push(event);
}

function streamedText(events: AgentEvent[]): string {
  return events
    .filter(
      (e): e is Extract<AgentEvent, { type: "text_delta" }> =>
        e.type === "text_delta",
    )
    .map((e) => e.text)
    .join("");
}

function textOf(content: ReadonlyArray<ContentBlock>): string {
  let out = "";
  for (const block of content) if (block.type === "text") out += block.text;
  return out;
}

function lastAssistant(history: Message[]): Message {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") return history[i];
  }
  throw new Error("no assistant message in history");
}

function registerOutputHookPlugin(hooks: {
  preModelCall?: (ctx: PreModelCallContext) => void;
  assistantMessage?: (ctx: AssistantMessageContext) => void;
}): void {
  registerPlugin({
    manifest: { name: "test-output-hooks", version: "0.0.0" },
    hooks: {
      ...(hooks.preModelCall
        ? {
            "pre-model-call": async (ctx: PreModelCallContext) => {
              hooks.preModelCall!(ctx);
            },
          }
        : {}),
      ...(hooks.assistantMessage
        ? {
            "assistant-message": async (ctx: AssistantMessageContext) => {
              hooks.assistantMessage!(ctx);
            },
          }
        : {}),
    },
  });
}

describe("agent loop output hooks", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
  });

  test("assistant-message transforms the persisted message content", async () => {
    registerOutputHookPlugin({
      assistantMessage: (ctx) => {
        ctx.content = ctx.content.map((b) =>
          b.type === "text"
            ? { type: "text", text: b.text.replace("secret", "[redacted]") }
            : b,
        );
      },
    });
    const { provider } = createMockProvider([textResponse("my secret value")]);
    const loop = new AgentLoop(provider, "system");
    const events: AgentEvent[] = [];
    const { history } = await loop.run([userMessage], collect(events));
    expect(textOf(lastAssistant(history).content)).toBe("my [redacted] value");
  });

  test("deferred output: the real stream is suppressed and the transformed text is emitted once", async () => {
    registerOutputHookPlugin({
      preModelCall: (ctx) => {
        ctx.deferAssistantOutput = true;
      },
      assistantMessage: (ctx) => {
        ctx.content = [{ type: "text", text: "[filtered]" }];
      },
    });
    const { provider } = createMockProvider([textResponse("my secret value")]);
    const loop = new AgentLoop(provider, "system");
    const events: AgentEvent[] = [];
    const { history } = await loop.run([userMessage], collect(events));
    // Her real words never streamed; only the transformed text did, once.
    expect(streamedText(events)).not.toContain("secret");
    expect(streamedText(events)).toBe("[filtered]");
    expect(textOf(lastAssistant(history).content)).toBe("[filtered]");
  });

  test("without defer, the real text still streams while storage is transformed", async () => {
    registerOutputHookPlugin({
      assistantMessage: (ctx) => {
        ctx.content = [{ type: "text", text: "[stored]" }];
      },
    });
    const { provider } = createMockProvider([textResponse("live text")]);
    const loop = new AgentLoop(provider, "system");
    const events: AgentEvent[] = [];
    const { history } = await loop.run([userMessage], collect(events));
    expect(streamedText(events)).toBe("live text"); // streamed live, untransformed
    expect(textOf(lastAssistant(history).content)).toBe("[stored]"); // storage transformed
  });

  test("transforms text but leaves tool_use blocks intact", async () => {
    const toolAndText: ProviderResponse = {
      content: [
        { type: "text", text: "calling" },
        { type: "tool_use", id: "t1", name: "noop", input: {} },
      ],
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "tool_use",
    };
    registerOutputHookPlugin({
      assistantMessage: (ctx) => {
        ctx.content = ctx.content.map((b) =>
          b.type === "text" ? { type: "text", text: b.text.toUpperCase() } : b,
        );
      },
    });
    const { provider } = createMockProvider([
      toolAndText,
      textResponse("done"),
    ]);
    const loop = new AgentLoop(provider, "system", {
      tools: [
        {
          name: "noop",
          description: "",
          input_schema: { type: "object", properties: {} },
        },
      ],
      toolExecutor: async () => ({ content: "ok", isError: false }),
    });
    const { history } = await loop.run([userMessage], collect([]));
    const toolTurn = history.find(
      (m) =>
        m.role === "assistant" && m.content.some((b) => b.type === "tool_use"),
    )!;
    expect(toolTurn.content.find((b) => b.type === "text")).toEqual({
      type: "text",
      text: "CALLING",
    });
    expect(toolTurn.content.find((b) => b.type === "tool_use")).toMatchObject({
      type: "tool_use",
      id: "t1",
      name: "noop",
    });
  });

  test("pre-model-call can edit the outbound system prompt", async () => {
    registerOutputHookPlugin({
      preModelCall: (ctx) => {
        ctx.systemPrompt = `${ctx.systemPrompt ?? ""} [EDITED]`;
      },
    });
    const { provider, calls } = createMockProvider([textResponse("hi")]);
    const loop = new AgentLoop(provider, "base prompt");
    await loop.run([userMessage], collect([]));
    expect(calls[0].systemPrompt).toContain("[EDITED]");
  });

  test("fail-open: a throwing assistant-message hook keeps the original content", async () => {
    registerOutputHookPlugin({
      assistantMessage: () => {
        throw new Error("boom");
      },
    });
    const { provider } = createMockProvider([textResponse("untouched")]);
    const loop = new AgentLoop(provider, "system");
    const { history } = await loop.run([userMessage], collect([]));
    expect(textOf(lastAssistant(history).content)).toBe("untouched");
  });
});
