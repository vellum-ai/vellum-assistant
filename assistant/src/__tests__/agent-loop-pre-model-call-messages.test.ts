/**
 * Tests for the `pre-model-call` hook's outbound-messages contract: a hook can
 * rewrite the wire payload the loop sends (without touching the loop's own
 * history bookkeeping) and can fail the model call outright via
 * `decision: "fail"`, ending the turn through the loop's normal error path
 * before anything reaches the provider. A throwing hook stays fail-open (the
 * call proceeds with the original request).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type { PreModelCallContext } from "../plugin-api/types.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import { registerPlugin } from "../plugins/registry.js";
import type { Message } from "../providers/types.js";
import { createMockProvider, textResponse } from "./helpers/mock-provider.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "Hello" }],
};

function collect(events: AgentEvent[]): (event: AgentEvent) => void {
  return (event) => events.push(event);
}

function registerPreModelCallPlugin(
  hook: (ctx: PreModelCallContext) => void,
): void {
  registerPlugin({
    manifest: { name: "test-pre-model-call", version: "0.0.0" },
    hooks: {
      "pre-model-call": async (ctx: PreModelCallContext) => {
        hook(ctx);
      },
    },
  });
}

describe("agent loop pre-model-call outbound messages", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
  });

  test("a hook-rewritten messages array is what the provider receives", async () => {
    registerPreModelCallPlugin((ctx) => {
      ctx.messages = [
        { role: "user", content: [{ type: "text", text: "rewritten" }] },
      ];
    });
    const { provider, calls } = createMockProvider([textResponse("ok")]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(1);
    const sent = calls[0].messages;
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toEqual([{ type: "text", text: "rewritten" }]);
    // Wire payload only: the loop's own history keeps the original user
    // message untouched.
    expect(history[0].content).toEqual([{ type: "text", text: "Hello" }]);
  });

  test("in-place mutation of ctx.messages reaches the wire without touching history", async () => {
    registerPreModelCallPlugin((ctx) => {
      for (const message of ctx.messages) {
        for (let i = 0; i < message.content.length; i++) {
          const block = message.content[i];
          if (block.type === "text") {
            message.content[i] = {
              type: "text",
              text: block.text.toUpperCase(),
            };
          }
        }
      }
    });
    const { provider, calls } = createMockProvider([textResponse("ok")]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls[0].messages[0].content).toEqual([
      { type: "text", text: "HELLO" },
    ]);
    expect(history[0].content).toEqual([{ type: "text", text: "Hello" }]);
  });

  test('decision "fail" ends the turn through the error path without a provider call', async () => {
    registerPreModelCallPlugin((ctx) => {
      ctx.decision = "fail";
      ctx.failureReason = "media bound for a text-only route";
    });
    const { provider, calls } = createMockProvider([textResponse("never")]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(0);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type !== "error") {
      throw new Error("type narrowing");
    }
    expect(errorEvent.error.message).toBe("media bound for a text-only route");
    const exitEvent = events.find((e) => e.type === "agent_loop_exit");
    expect(exitEvent).toBeDefined();
    if (exitEvent?.type !== "agent_loop_exit") {
      throw new Error("type narrowing");
    }
    expect(exitEvent.reason).toBe("error");
  });

  test('decision "fail" without a failureReason surfaces the generic message', async () => {
    registerPreModelCallPlugin((ctx) => {
      ctx.decision = "fail";
    });
    const { provider, calls } = createMockProvider([textResponse("never")]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(0);
    const errorEvent = events.find((e) => e.type === "error");
    if (errorEvent?.type !== "error") {
      throw new Error("expected an error event");
    }
    expect(errorEvent.error.message).toBe(
      "A pre-model-call hook failed this model call",
    );
  });

  test("a throwing hook is fail-open: the call proceeds with the original request", async () => {
    registerPreModelCallPlugin(() => {
      throw new Error("hook exploded");
    });
    const { provider, calls } = createMockProvider([textResponse("ok")]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });
    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].content).toEqual([
      { type: "text", text: "Hello" },
    ]);
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });
});
