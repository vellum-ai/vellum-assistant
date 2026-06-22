import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../../../../providers/types.js";

// Stub the provider resolution; spread the real module so `extractAllText` /
// `userMessage` (which the consult also uses) keep working.
let sendMessageArgs: Record<string, unknown> | null = null;
let responseText = "Use a channel-based worker pool; drain on shutdown.";
let sendMessageError: Error | null = null;
let providerResolves = true;

const fakeProvider = {
  name: "mock-advisor-provider",
  async sendMessage(messages: unknown, options: unknown) {
    sendMessageArgs = { messages, options } as Record<string, unknown>;
    if (sendMessageError) throw sendMessageError;
    return {
      content: [{ type: "text", text: responseText }],
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  },
};

const realPsm = await import("../../../../providers/provider-send-message.js");
mock.module("../../../../providers/provider-send-message.js", () => ({
  ...realPsm,
  getConfiguredProvider: async () => (providerResolves ? fakeProvider : null),
}));

const { consultAdvisor } = await import("../consult.js");
const advisorTool = (await import("../tools/advisor.js")).default;
const { recordSystemPrompt, recordMessages, resetAdvisorStateForTests } =
  await import("../advisor-state-store.js");

const userMsg = (t: string): Message => ({
  role: "user",
  content: [{ type: "text", text: t }],
});

function optionConfig(): Record<string, unknown> {
  const options = sendMessageArgs?.options as Record<string, unknown>;
  return options.config as Record<string, unknown>;
}

beforeEach(() => {
  sendMessageArgs = null;
  responseText = "Use a channel-based worker pool; drain on shutdown.";
  sendMessageError = null;
  providerResolves = true;
  resetAdvisorStateForTests();
});

describe("consultAdvisor", () => {
  test("routes through the advisor call site, tools off, returns advice", async () => {
    const messages: Message[] = [
      userMsg("build a worker pool"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret", signature: "s" },
          { type: "text", text: "let me consult the advisor" },
          { type: "tool_use", id: "t1", name: "advisor", input: {} },
        ],
      },
    ];

    const advice = await consultAdvisor({
      systemPrompt: "You are a coding agent.",
      messages,
    });

    expect(advice).toBe(responseText);

    const config = optionConfig();
    expect(config.callSite).toBe("advisor");
    // No `advisorProfile` is configured in the default test config, so the
    // consult passes no override and the `advisor` call site resolves to its
    // default profile (`quality-optimized`).
    expect(config.overrideProfile).toBeUndefined();
    expect(config.tool_choice).toEqual({ type: "none" });
    // No advisor-specific output cap — the resolver applies the profile budget.
    expect(config.max_tokens).toBeUndefined();

    const sent = sendMessageArgs?.messages as Message[];
    expect(sent[0]).toEqual(userMsg("build a worker pool"));
    expect(sent[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "let me consult the advisor" }],
    });
    const lastText = (sent[sent.length - 1].content[0] as { text: string })
      .text;
    expect(lastText).toContain("focused strategic guidance");
    // The request carries no word limit.
    expect(lastText).not.toContain("words");

    const options = sendMessageArgs?.options as { systemPrompt: string };
    expect(options.systemPrompt).toContain("senior advisor");
    expect(options.systemPrompt).toContain("You are a coding agent.");
  });

  test("soft-fails when no provider is configured", async () => {
    providerResolves = false;
    const advice = await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("hi")],
    });
    expect(advice).toContain("no inference provider");
  });

  test("returns a notice when there is no usable transcript", async () => {
    const advice = await consultAdvisor({ systemPrompt: null, messages: [] });
    expect(advice).toContain("no conversation context");
    expect(sendMessageArgs).toBeNull();
  });

  test("falls back to a notice when the advisor returns blank text", async () => {
    responseText = "   ";
    const advice = await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("hi")],
    });
    expect(advice).toContain("no guidance");
  });
});

describe("advisor tool.execute", () => {
  test("reads the captured transcript and returns guidance as a non-error result", async () => {
    recordSystemPrompt("c1", "You are a coding agent.");
    recordMessages("c1", [userMsg("build a worker pool")]);

    const result = await advisorTool.execute?.({}, {
      conversationId: "c1",
    } as never);

    expect(result?.isError).toBe(false);
    expect(result?.content).toBe(responseText);
  });

  test("degrades to a benign result (never throws) when the consult fails", async () => {
    recordMessages("c2", [userMsg("hi")]);
    sendMessageError = new Error("kaboom");

    const result = await advisorTool.execute?.({}, {
      conversationId: "c2",
    } as never);

    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("advisor unavailable");
    expect(result?.content).toContain("kaboom");
  });
});
