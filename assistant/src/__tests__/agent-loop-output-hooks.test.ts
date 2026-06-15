/**
 * Tests for the `pre-model-call` and `post-model-call` plugin hooks: a plugin
 * can edit the outbound request, transform the finalized assistant message
 * (persisted + streamed), and defer the live stream so the transformed text is
 * emitted once. All hooks here use neutral transforms (redaction / uppercasing).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type {
  PostModelCallContext,
  PreModelCallContext,
} from "../plugin-api/types.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import { registerPlugin } from "../plugins/registry.js";
import type {
  ContentBlock,
  Message,
  ProviderResponse,
} from "../providers/types.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
} from "./helpers/mock-provider.js";

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
  postModelCall?: (ctx: PostModelCallContext) => void;
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
      ...(hooks.postModelCall
        ? {
            "post-model-call": async (ctx: PostModelCallContext) => {
              hooks.postModelCall!(ctx);
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

  test("post-model-call transforms the persisted message content", async () => {
    registerOutputHookPlugin({
      postModelCall: (ctx) => {
        ctx.content = ctx.content.map((b) =>
          b.type === "text"
            ? { type: "text", text: b.text.replace("secret", "[redacted]") }
            : b,
        );
      },
    });
    const { provider } = createMockProvider([textResponse("my secret value")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });
    expect(textOf(lastAssistant(history).content)).toBe("my [redacted] value");
  });

  test("deferred output: the real stream is suppressed and the transformed text is emitted once", async () => {
    registerOutputHookPlugin({
      preModelCall: (ctx) => {
        ctx.deferAssistantOutput = true;
      },
      postModelCall: (ctx) => {
        ctx.content = [{ type: "text", text: "[filtered]" }];
      },
    });
    const { provider } = createMockProvider([textResponse("my secret value")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });
    // Her real words never streamed; only the transformed text did, once.
    expect(streamedText(events)).not.toContain("secret");
    expect(streamedText(events)).toBe("[filtered]");
    expect(textOf(lastAssistant(history).content)).toBe("[filtered]");
  });

  test("without defer, the real text still streams while storage is transformed", async () => {
    registerOutputHookPlugin({
      postModelCall: (ctx) => {
        ctx.content = [{ type: "text", text: "[stored]" }];
      },
    });
    const { provider } = createMockProvider([textResponse("live text")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });
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
      postModelCall: (ctx) => {
        ctx.content = ctx.content.map((b) =>
          b.type === "text" ? { type: "text", text: b.text.toUpperCase() } : b,
        );
      },
    });
    const { provider } = createMockProvider([
      toolAndText,
      textResponse("done"),
    ]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: [
        {
          name: "noop",
          description: "",
          input_schema: { type: "object", properties: {} },
        },
      ],
      toolExecutor: async () => ({ content: "ok", isError: false }),
    });
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect([]),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });
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

  test("post-model-call can append a tool_use block to invoke a tool as if the model had called it", async () => {
    // GIVEN a plugin whose post-model-call hook appends a tool call (with an
    // empty id, so the host must assign one) to an otherwise text-only reply,
    // once, so the re-entry turn terminates the run.
    let injected = false;
    const executed: Array<{ name: string; input: unknown; id?: string }> = [];
    registerOutputHookPlugin({
      postModelCall: (ctx) => {
        if (injected) return;
        injected = true;
        ctx.content = [
          ...ctx.content,
          {
            type: "tool_use",
            id: "",
            name: "ui_show",
            input: { surface: "x" },
          },
        ];
      },
    });
    // AND a provider that streams a visible answer, then ends after re-entry.
    const { provider } = createMockProvider([
      textResponse("here is your answer"),
      textResponse("done"),
    ]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: [
        {
          name: "ui_show",
          description: "",
          input_schema: { type: "object", properties: {} },
        },
      ],
      toolExecutor: async (name, input, _onOutput, toolUseId) => {
        executed.push({ name, input, id: toolUseId });
        return { content: "shown", isError: false };
      },
    });
    const events: AgentEvent[] = [];

    // WHEN the loop runs
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN the hook-added call ran through the normal tool path exactly once
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      name: "ui_show",
      input: { surface: "x" },
    });
    // AND the host backfilled a non-empty id for the empty-id block
    expect(executed[0].id).toBeTruthy();
    // AND a tool_use event was emitted for the injected call
    expect(
      events.some((e) => e.type === "tool_use" && e.name === "ui_show"),
    ).toBe(true);
    // AND the live text reply was preserved, not discarded
    expect(streamedText(events)).toContain("here is your answer");
    // AND the persisted assistant turn carries the injected tool call
    const injectedTurn = history.find(
      (m) =>
        m.role === "assistant" &&
        m.content.some((b) => b.type === "tool_use" && b.name === "ui_show"),
    );
    expect(injectedTurn).toBeDefined();
  });

  test("post-model-call can drop a model tool_use block to suppress the call", async () => {
    // GIVEN a model reply that carries a tool call the hook decides to remove.
    const toolAndText: ProviderResponse = {
      content: [
        { type: "text", text: "answer" },
        { type: "tool_use", id: "t1", name: "noop", input: {} },
      ],
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "tool_use",
    };
    let executions = 0;
    registerOutputHookPlugin({
      postModelCall: (ctx) => {
        ctx.content = ctx.content.filter((b) => b.type !== "tool_use");
      },
    });
    const { provider } = createMockProvider([toolAndText]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: [
        {
          name: "noop",
          description: "",
          input_schema: { type: "object", properties: {} },
        },
      ],
      toolExecutor: async () => {
        executions++;
        return { content: "ok", isError: false };
      },
    });

    // WHEN the loop runs
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect([]),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN the dropped call never executed and the turn ended on the text reply
    expect(executions).toBe(0);
    expect(
      lastAssistant(history).content.some((b) => b.type === "tool_use"),
    ).toBe(false);
  });

  test("pre-model-call can edit the outbound system prompt", async () => {
    registerOutputHookPlugin({
      preModelCall: (ctx) => {
        ctx.systemPrompt = `${ctx.systemPrompt ?? ""} [EDITED]`;
      },
    });
    const { provider, calls } = createMockProvider([textResponse("hi")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "base prompt",
      conversationId: "test-conversation",
    });
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect([]),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });
    expect(calls[0].systemPrompt).toContain("[EDITED]");
  });

  test("fail-open: a hook that mutates in place AND then throws cannot corrupt the persisted content", async () => {
    // The hook mutates the array it receives before throwing. If the loop
    // handed the hook the real `assistantMessage.content` array, the
    // mid-mutation would survive into history. The loop must clone the
    // content before invoking the hook.
    registerOutputHookPlugin({
      postModelCall: (ctx) => {
        ctx.content.push({ type: "text", text: "[INJECTED]" });
        throw new Error("boom");
      },
    });
    const { provider } = createMockProvider([textResponse("untouched")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect([]),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });
    const finalContent = lastAssistant(history).content;
    expect(textOf(finalContent)).toBe("untouched");
    expect(
      finalContent.some((b) => b.type === "text" && b.text === "[INJECTED]"),
    ).toBe(false);
  });

  test("max_tokens turn: the hook fires and the deferred final text is emitted", async () => {
    // Without this, an output-filter plugin misses the truncated reply; with
    // defer set, the live stream was suppressed and the client would see
    // nothing at all.
    const seen: { calls: number } = { calls: 0 };
    registerOutputHookPlugin({
      preModelCall: (ctx) => {
        ctx.deferAssistantOutput = true;
      },
      postModelCall: (ctx) => {
        seen.calls += 1;
        ctx.content = ctx.content.map((b) =>
          b.type === "text" ? { type: "text", text: b.text.toUpperCase() } : b,
        );
      },
    });
    const truncated: ProviderResponse = {
      content: [{ type: "text", text: "partial answer" }],
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "max_tokens",
    };
    const { provider } = createMockProvider([truncated]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });
    expect(seen.calls).toBe(1);
    expect(textOf(lastAssistant(history).content)).toBe("PARTIAL ANSWER");
    // Real stream suppressed; transformed final text emitted once.
    expect(streamedText(events)).toBe("PARTIAL ANSWER");
  });

  test("max_tokens turn: a hook-added tool_use is dropped, not executed or persisted", async () => {
    // GIVEN a hook that appends a tool call while transforming a truncated
    // reply. A max-tokens turn short-circuits before the executor runs, so the
    // injected call must be dropped rather than persisted without a result.
    const executed: string[] = [];
    registerOutputHookPlugin({
      postModelCall: (ctx) => {
        ctx.content = [
          ...ctx.content,
          { type: "tool_use", id: "", name: "ui_show", input: {} },
        ];
      },
    });
    // AND a provider whose only reply is truncated at the token limit.
    const truncated: ProviderResponse = {
      content: [{ type: "text", text: "partial" }],
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "max_tokens",
    };
    const { provider } = createMockProvider([truncated]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: [
        {
          name: "ui_show",
          description: "",
          input_schema: { type: "object", properties: {} },
        },
      ],
      toolExecutor: async (name) => {
        executed.push(name);
        return { content: "shown", isError: false };
      },
    });
    const events: AgentEvent[] = [];

    // WHEN the loop runs
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN the injected call never executed
    expect(executed).toHaveLength(0);
    expect(
      events.some((e) => e.type === "tool_use" && e.name === "ui_show"),
    ).toBe(false);
    // AND the persisted truncated turn carries no tool call
    expect(
      lastAssistant(history).content.some((b) => b.type === "tool_use"),
    ).toBe(false);
  });

  test("deferred final text passes through sensitive-output substitution", async () => {
    // A tool returns a sensitive binding; the next assistant turn uses the
    // placeholder (the persisted message must keep it — model never sees real
    // values on reload), but the deferred final stream must show the real
    // value, just like the normal live stream would.
    registerOutputHookPlugin({
      preModelCall: (ctx) => {
        ctx.deferAssistantOutput = true;
      },
    });
    const placeholder = "VELLUM_ASSISTANT_INVITE_CODE_TESTXXXX";
    const real = "real-invite-code-xyz";
    const toolThenText = [
      {
        content: [{ type: "tool_use", id: "t1", name: "issue", input: {} }],
        model: "mock-model",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      } as ProviderResponse,
      textResponse(`Your code is ${placeholder}.`),
    ];
    const { provider } = createMockProvider(toolThenText);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: [
        {
          name: "issue",
          description: "",
          input_schema: { type: "object", properties: {} },
        },
      ],
      toolExecutor: async () => ({
        content: `code=${placeholder}`,
        isError: false,
        sensitiveBindings: [{ kind: "invite_code", placeholder, value: real }],
      }),
    });
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });
    // Persisted message keeps the placeholder — model must never see real
    // values on reload.
    expect(textOf(lastAssistant(history).content)).toContain(placeholder);
    expect(textOf(lastAssistant(history).content)).not.toContain(real);
    // Streamed final text shows the substituted real value, matching the
    // behavior of the normal live stream.
    expect(streamedText(events)).toContain(real);
    expect(streamedText(events)).not.toContain(placeholder);
  });
});

/**
 * Tests for the `post-model-call` retry decision: a hook can set
 * `decision: "continue"` to re-query the model with a repaired/extended
 * `messages` history. The decision is honored only at actionable outcomes — a
 * no-tool reply or a provider rejection — and a per-run backstop bounds a
 * misbehaving hook. The hook also receives the rejection via `error` so it can
 * recover from a thrown provider call, not just a finalized reply.
 */
describe("agent loop post-model-call retry decision", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
  });

  test("a no-tool reply with decision=continue re-queries with the hook's messages", async () => {
    // GIVEN a hook that, once, asks to continue and appends a nudge turn,
    // deferring output so the discarded reply was never streamed live
    let continued = false;
    const nudge: Message = {
      role: "user",
      content: [{ type: "text", text: "try again" }],
    };
    registerOutputHookPlugin({
      preModelCall: (ctx) => {
        ctx.deferAssistantOutput = true;
      },
      postModelCall: (ctx) => {
        if (ctx.error) return;
        if (continued) return;
        continued = true;
        ctx.messages = [...ctx.messages, nudge];
        ctx.decision = "continue";
      },
    });
    // AND a provider that returns a first reply then a second
    const { provider, calls } = createMockProvider([
      textResponse("first"),
      textResponse("second"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    // WHEN the loop runs
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect([]),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN the model was re-queried with the hook's repaired history
    expect(calls.length).toBe(2);
    expect(textOf(calls[1].messages.at(-1)!.content)).toBe("try again");
    // AND the kept reply is the re-queried one, not the discarded first reply
    expect(textOf(lastAssistant(history).content)).toBe("second");
    expect(history.some((m) => textOf(m.content) === "first")).toBe(false);
  });

  test("a hook that always continues is bounded by the per-run backstop", async () => {
    // GIVEN a hook that asks to continue on every no-tool reply, deferring
    // output so each discarded reply was never streamed live
    registerOutputHookPlugin({
      preModelCall: (ctx) => {
        ctx.deferAssistantOutput = true;
      },
      postModelCall: (ctx) => {
        if (ctx.error) return;
        ctx.decision = "continue";
      },
    });
    // AND a provider that always returns a no-tool reply
    const { provider, calls } = createMockProvider([textResponse("loop")]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    // WHEN the loop runs
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect([]),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN it terminates after the backstop is spent (5 continues + 1 accepted)
    expect(calls.length).toBe(6);
    expect(textOf(lastAssistant(history).content)).toBe("loop");
  });

  test("decision=continue is ignored on an already-streamed visible reply", async () => {
    /**
     * A retry discards the reply and re-queries; honoring it on a reply whose
     * text already streamed live would strand the user on an answer the
     * transcript silently replaces. The loop keeps such a turn instead.
     */
    // GIVEN a hook that asks to continue on a visible reply without deferring
    // its output, so the reply was streamed to the client live
    let asked = false;
    registerOutputHookPlugin({
      postModelCall: (ctx) => {
        if (ctx.error) return;
        asked = true;
        ctx.decision = "continue";
      },
    });
    // AND a provider whose first reply carries visible text
    const { provider, calls } = createMockProvider([
      textResponse("visible"),
      textResponse("second"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    // WHEN the loop runs
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN the hook ran but the streamed reply is kept rather than discarded
    expect(asked).toBe(true);
    expect(calls.length).toBe(1);
    expect(textOf(lastAssistant(history).content)).toBe("visible");
    // AND the visible text the user already saw is the one that stands
    expect(streamedText(events)).toBe("visible");
  });

  test("a provider rejection invokes the hook with the error and can recover", async () => {
    // GIVEN a hook that recovers from a rejection once, recording what it saw
    const seen: { error?: Error; contentLength?: number } = {};
    let recovered = false;
    registerOutputHookPlugin({
      postModelCall: (ctx) => {
        if (!ctx.error) return;
        seen.error = ctx.error;
        seen.contentLength = ctx.content.length;
        if (recovered) return;
        recovered = true;
        ctx.decision = "continue";
      },
    });
    // AND a provider that throws once then succeeds
    const rejection = new Error("ordering violation");
    const { provider, calls } = createMockProvider([
      rejection,
      textResponse("recovered"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    // WHEN the loop runs
    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN the hook saw the rejection with empty content
    expect(seen.error).toBe(rejection);
    expect(seen.contentLength).toBe(0);
    // AND the call was re-issued and the recovery reply kept, no error surfaced
    expect(calls.length).toBe(2);
    expect(textOf(lastAssistant(history).content)).toBe("recovered");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("a provider rejection the hook does not recover is surfaced", async () => {
    // GIVEN a hook that inspects but never continues on a rejection
    registerOutputHookPlugin({
      postModelCall: (ctx) => {
        if (!ctx.error) return;
      },
    });
    // AND a provider that always throws
    const { provider, calls } = createMockProvider([new Error("boom")]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    // WHEN the loop runs
    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN the rejection is surfaced and not retried
    expect(calls.length).toBe(1);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  test("decision=continue is ignored on a tool-bearing turn", async () => {
    // GIVEN a hook that asks to continue only on a reply carrying a tool_use
    registerOutputHookPlugin({
      postModelCall: (ctx) => {
        if (ctx.content.some((b) => b.type === "tool_use")) {
          ctx.decision = "continue";
        }
      },
    });
    // AND a provider that calls a tool then returns a final reply
    const { provider, calls } = createMockProvider([
      toolUseResponse("t1", "noop", {}),
      textResponse("done"),
    ]);
    let toolRuns = 0;
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      tools: [
        {
          name: "noop",
          description: "",
          input_schema: { type: "object", properties: {} },
        },
      ],
      toolExecutor: async () => {
        toolRuns += 1;
        return { content: "ok", isError: false };
      },
    });

    // WHEN the loop runs
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect([]),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // THEN the tool ran normally (the continue did not discard the tool_use)
    expect(toolRuns).toBe(1);
    expect(
      history.some((m) => m.content.some((b) => b.type === "tool_result")),
    ).toBe(true);
    // AND the loop continued naturally to the final reply, no extra re-query
    expect(calls.length).toBe(2);
    expect(textOf(lastAssistant(history).content)).toBe("done");
  });
});
