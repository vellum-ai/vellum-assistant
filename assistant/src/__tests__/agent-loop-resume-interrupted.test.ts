/**
 * Cover for the loop's interrupted-call recovery.
 *
 * The reported failure: the model runs several tools, the next call streams for
 * a while and then dies (the upstream killed a generation that blew its decode
 * deadline), and the loop surfaces the error and ends the turn — leaving the
 * task half-done until the user types "continue". These tests assert the loop
 * now carries on by itself, and that it still stops when carrying on would be
 * pointless.
 *
 * The recovery is built into {@link AgentLoop}, not contributed by a plugin, so
 * these run it as the loop's own behavior. The default plugin stack is
 * registered because the loop fires hook chains during a turn regardless.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";
import { ProviderError } from "../util/errors.js";

const tools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
];

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "finish the course page" }],
};

/** The rejection from the reported turn, thrown from inside a live stream. */
function midStreamRejection(): ProviderError {
  return new ProviderError(
    "OpenAI-compatible API error (unknown status): litellm.MidStreamFallbackError: " +
      "litellm.APIConnectionError: OpenAIException - Decode wall clock timeout after 600s",
    "openai-compatible",
  );
}

/** A scripted turn: return a response, or stream `thinking` and then throw. */
type Turn =
  | { kind: "reply"; response: ProviderResponse }
  | { kind: "interrupt"; thinking: string }
  | { kind: "refuse" };

function scriptedProvider(turns: Turn[]): {
  provider: Provider;
  callCount: () => number;
} {
  let index = 0;
  const provider: Provider = {
    name: "openai-compatible",
    async sendMessage(
      _messages: Message[],
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      const turn = turns[Math.min(index, turns.length - 1)]!;
      index++;
      if (turn.kind === "refuse") {
        // Rejected before generating: nothing ever streams.
        throw midStreamRejection();
      }
      if (turn.kind === "interrupt") {
        options?.onEvent?.({ type: "thinking_delta", thinking: turn.thinking });
        throw midStreamRejection();
      }
      for (const block of turn.response.content) {
        if (block.type === "text") {
          options?.onEvent?.({ type: "text_delta", text: block.text });
        }
      }
      return turn.response;
    },
  };
  return { provider, callCount: () => index };
}

function reply(text: string): Turn {
  return {
    kind: "reply",
    response: {
      content: [{ type: "text", text }],
      model: "glm-5.2",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn",
    },
  };
}

function callsTool(id: string): Turn {
  return {
    kind: "reply",
    response: {
      content: [
        { type: "tool_use", id, name: "read_file", input: { path: "app.js" } },
      ],
      model: "glm-5.2",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "tool_use",
    },
  };
}

function runLoop(provider: Provider, callSite: LLMCallSite = "mainAgent") {
  const events: AgentEvent[] = [];
  const loop = new AgentLoop({
    provider,
    systemPrompt: "system",
    conversationId: "conv-resume-e2e",
    tools,
    toolExecutor: async () => ({ content: "file data", isError: false }),
  });
  return loop
    .run({
      requestId: "req-resume-e2e",
      messages: [userMessage],
      callSite,
      onEvent: (event) => {
        events.push(event);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    })
    .then((result) => ({ ...result, events }));
}

function assistantTextOf(history: Message[]): string {
  return history
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

describe("AgentLoop — a call interrupted mid-generation", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
  });

  test("carries on instead of ending the turn", async () => {
    const { provider, callCount } = scriptedProvider([
      callsTool("call-1"),
      { kind: "interrupt", thinking: "Now I need to understand the layout" },
      reply("Done — the page is wired up."),
    ]);

    const { history, events } = await runLoop(provider);

    // The turn finished on its own: tool call, interrupted call, resumed call.
    expect(callCount()).toBe(3);
    expect(assistantTextOf(history)).toContain("Done — the page is wired up.");
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  });

  test("keeps the tool work the interrupted turn had already done", async () => {
    const { provider } = scriptedProvider([
      callsTool("call-1"),
      { kind: "interrupt", thinking: "reading the file" },
      reply("Summary of the file."),
    ]);

    const { history } = await runLoop(provider);

    // The resumed call re-sends the same history, so the completed tool call
    // and its result are still there rather than being replayed or dropped.
    const toolUses = history
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_use");
    const toolResults = history
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result");
    expect(toolUses).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
  });

  test("surfaces the error when the resumed call is interrupted too", async () => {
    const { provider, callCount } = scriptedProvider([
      { kind: "interrupt", thinking: "starting" },
    ]);

    const { events } = await runLoop(provider);

    // One resume, then the error stands rather than looping.
    expect(callCount()).toBe(2);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  });

  test("does not resume a background call site", async () => {
    // A compaction, subagent, or other background call answers to a caller
    // that owns its own failure handling; nobody is sitting there to type
    // "continue" at it.
    const { provider, callCount } = scriptedProvider([
      { kind: "interrupt", thinking: "summarizing" },
    ]);

    await runLoop(provider, "compactionAgent");

    expect(callCount()).toBe(1);
  });

  test("does not resume a request the provider refused outright", async () => {
    // Nothing streamed, so re-sending the identical request would fail the same
    // way; the error surfaces on the first rejection.
    const { provider, callCount } = scriptedProvider([{ kind: "refuse" }]);

    const { events } = await runLoop(provider);

    expect(callCount()).toBe(1);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  });
});
