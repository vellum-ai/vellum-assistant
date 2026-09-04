/**
 * Agent-loop behavior under `suppressAssistantText` (the daemon sets it for a
 * main-agent run with the `send-user-message` flag on):
 *
 * - streamed assistant text is dropped, and each `send_user_message` call's
 *   message is streamed in its place,
 * - the model-native history still carries the raw text blocks,
 * - a run that never calls the tool surfaces its final text as the fallback,
 * - and with the option unset nothing changes.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import type {
  ContentBlock,
  Message,
  ProviderResponse,
} from "../providers/types.js";
import { createMockProvider, textResponse } from "./helpers/mock-provider.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "What is on my calendar?" }],
};

const trust = { sourceChannel: "vellum", trustClass: "unknown" } as const;

function collect(events: AgentEvent[]): (event: AgentEvent) => void {
  return (event) => events.push(event);
}

function visibilityMarks(events: AgentEvent[]): Array<string | undefined> {
  return events
    .filter(
      (e): e is Extract<AgentEvent, { type: "message_complete" }> =>
        e.type === "message_complete",
    )
    .map((e) => e.assistantTextVisibility);
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

/** A scripted turn that thinks in plain text and then sends a message. */
function textAndSend(
  text: string,
  message: string,
  id = "tu_1",
): ProviderResponse {
  return {
    content: [
      { type: "text", text },
      {
        type: "tool_use",
        id,
        name: "send_user_message",
        input: { message },
      },
    ] as ContentBlock[],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "tool_use",
  };
}

function loopWith(provider: ReturnType<typeof createMockProvider>["provider"]) {
  return new AgentLoop({
    provider,
    systemPrompt: "system",
    conversationId: "test-conversation",
    toolExecutor: async () => ({ content: "Delivered.", isError: false }),
  });
}

describe("agent loop under the tool-gated reply surface", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
  });

  test("streams the tool's message and never the model's plain text", async () => {
    const { provider } = createMockProvider([
      textAndSend("The user wants their calendar. Checking.", "Checking now."),
      textAndSend(
        "Nothing left to do.",
        "You have two meetings today.",
        "tu_2",
      ),
      textResponse("Wrapping up."),
    ]);
    const events: AgentEvent[] = [];
    const { history } = await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust,
      suppressAssistantText: true,
    });

    expect(streamedText(events)).toBe(
      "Checking now.You have two meetings today.",
    );
    // The scratchpad survives in history so the model sees it on resume.
    const assistantText = history
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content)
      .filter(
        (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join(" ");
    expect(assistantText).toContain("The user wants their calendar");
    // Every row of a suppressed run is marked private, so the read-side
    // projection hides the scratchpad without consulting the flag.
    expect(visibilityMarks(events).every((v) => v === "private")).toBe(true);
  });

  test("streams the model's text when the option is unset", async () => {
    const { provider } = createMockProvider([
      textResponse("You have two meetings today."),
    ]);
    const events: AgentEvent[] = [];
    await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust,
    });
    expect(streamedText(events)).toBe("You have two meetings today.");
    // An ordinary run marks nothing, so its rows render exactly as today.
    expect(visibilityMarks(events)).toEqual([undefined]);
  });

  test("surfaces the final text when the tool was never called", async () => {
    // The loop's own fallback: a turn that ends with no tool call and no
    // `send_user_message` this run surfaces its text rather than going silent.
    // (The plugin's one-shot nudge that precedes it is covered in
    // `empty-response-hook-send-user-message.test.ts`.)
    const { provider } = createMockProvider([
      textResponse("Two meetings today."),
    ]);
    const events: AgentEvent[] = [];
    await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust,
      callSite: "mainAgent",
      suppressAssistantText: true,
    });
    expect(streamedText(events)).toBe("Two meetings today.");
    // The fallback row is marked visible: the user saw this text, so history
    // and channel delivery have to carry it too.
    expect(visibilityMarks(events)).toEqual(["visible"]);
  });

  test("surfaces the result when a progress update was followed by work", async () => {
    // The model sends "Checking your calendar." alongside the tool call it
    // announces, then ends with the answer in plain text. The progress update
    // is not the outcome, so the final text is surfaced rather than swallowed.
    const { provider } = createMockProvider([
      {
        content: [
          { type: "text", text: "Looking this up." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "send_user_message",
            input: { message: "Checking your calendar." },
          },
          {
            type: "tool_use",
            id: "tu_2",
            name: "bash",
            input: { command: "true" },
          },
        ] as ContentBlock[],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      textResponse("You have two meetings today."),
    ]);
    const events: AgentEvent[] = [];
    await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust,
      callSite: "mainAgent",
      suppressAssistantText: true,
    });
    expect(streamedText(events)).toBe(
      "Checking your calendar.You have two meetings today.",
    );
    expect(visibilityMarks(events)).toEqual(["private", "visible"]);
  });

  test("keeps working notes unsent on an intermediate tool-bearing turn", async () => {
    const { provider } = createMockProvider([
      {
        content: [
          { type: "text", text: "Let me look that up." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "bash",
            input: { command: "true" },
          },
        ] as ContentBlock[],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      textAndSend("Done thinking.", "You have two meetings today.", "tu_2"),
      textResponse("Wrapping up."),
    ]);
    const events: AgentEvent[] = [];
    await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust,
      suppressAssistantText: true,
    });
    expect(streamedText(events)).toBe("You have two meetings today.");
  });
});
