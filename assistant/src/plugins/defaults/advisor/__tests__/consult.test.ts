import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../../../../providers/types.js";

// ── Mocks for the Vellum-routed inference boundary ──────────────────────────
// The consult must route through `getConfiguredProvider` + `runBtwSidechain`
// rather than create its own client; mocking both lets us assert exactly what
// the advisor sub-call receives without a real provider or network.
let providerResult: unknown = { name: "mock-advisor-provider" };
let sidechainArgs: Record<string, unknown> | null = null;
let sidechainText = "Use a channel-based worker pool; drain on shutdown.";
let sidechainError: Error | null = null;

// Spread the real module so non-overridden exports stay available when this
// file shares a process with others (a single `bun test <dir>` invocation).
const realProviderSendMessage =
  await import("../../../../providers/provider-send-message.js");
mock.module("../../../../providers/provider-send-message.js", () => ({
  ...realProviderSendMessage,
  getConfiguredProvider: async () => providerResult,
}));
mock.module("../../../../runtime/btw-sidechain.js", () => ({
  runBtwSidechain: async (params: Record<string, unknown>) => {
    sidechainArgs = params;
    if (sidechainError) throw sidechainError;
    return { text: sidechainText, hadTextDeltas: true, response: {} };
  },
}));

const { consultAdvisor } = await import("../consult.js");
const advisorTool = (await import("../tools/advisor.js")).default;
const { recordSystemPrompt, recordMessages, resetAdvisorStateForTests } =
  await import("../advisor-state-store.js");

const userMsg = (t: string): Message => ({
  role: "user",
  content: [{ type: "text", text: t }],
});

beforeEach(() => {
  providerResult = { name: "mock-advisor-provider" };
  sidechainArgs = null;
  sidechainText = "Use a channel-based worker pool; drain on shutdown.";
  sidechainError = null;
  resetAdvisorStateForTests();
});

describe("consultAdvisor", () => {
  test("routes through the advisor call site, tools off, capped, and returns the advice", async () => {
    const messages: Message[] = [
      userMsg("build a worker pool"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret reasoning", signature: "s" },
          { type: "text", text: "let me consult the advisor" },
          { type: "tool_use", id: "t1", name: "advisor", input: {} },
        ],
      },
    ];

    const advice = await consultAdvisor({
      systemPrompt: "You are a coding agent.",
      messages,
    });

    expect(advice).toBe(sidechainText);
    expect(sidechainArgs?.callSite).toBe("advisor");
    expect(sidechainArgs?.tools).toEqual([]);
    expect(sidechainArgs?.maxTokens).toBe(2048);

    // Thinking dropped + the pending advisor tool_use stripped from the final turn.
    expect(sidechainArgs?.messages).toEqual([
      userMsg("build a worker pool"),
      {
        role: "assistant",
        content: [{ type: "text", text: "let me consult the advisor" }],
      },
    ]);

    // Advisor system prompt frames the role and quotes the agent's system prompt.
    expect(sidechainArgs?.systemPrompt).toContain("senior technical advisor");
    expect(sidechainArgs?.systemPrompt).toContain("You are a coding agent.");

    // The consult's user turn carries the soft word-limit nudge.
    expect(sidechainArgs?.content).toContain("80 words");
  });

  test("soft-fails when no provider is configured", async () => {
    providerResult = null;
    const advice = await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("hi")],
    });
    expect(advice).toContain("no inference provider");
  });

  test("returns a notice when there is no usable transcript", async () => {
    const advice = await consultAdvisor({ systemPrompt: null, messages: [] });
    expect(advice).toContain("no conversation context");
    expect(sidechainArgs).toBeNull(); // never reached the provider
  });

  test("falls back to a notice when the advisor returns blank text", async () => {
    sidechainText = "   ";
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
    expect(result?.content).toBe(sidechainText);
    expect(sidechainArgs?.callSite).toBe("advisor");
  });

  test("degrades to a benign result (never throws) when the consult fails", async () => {
    recordMessages("c2", [userMsg("hi")]);
    sidechainError = new Error("kaboom"); // the routed inference rejects

    const result = await advisorTool.execute?.({}, {
      conversationId: "c2",
    } as never);

    // The turn must not fail: a benign, non-error result is returned.
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("advisor unavailable");
    expect(result?.content).toContain("kaboom");
  });
});
