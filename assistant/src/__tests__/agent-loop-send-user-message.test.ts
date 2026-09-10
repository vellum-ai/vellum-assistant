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
import type { PostModelCallContext } from "../plugin-api/types.js";
import {
  NUDGE_TEXT,
  SEND_USER_MESSAGE_NUDGE_TEXT,
} from "../plugins/defaults/empty-response/hooks/post-model-call.js";
import { resetEmptyResponseNudgeStoreForTests } from "../plugins/defaults/empty-response/nudge-state-store.js";
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
    // The nudge is one-shot per conversation and every case here shares one
    // id, so without this the first suppressed run consumes it for the file.
    resetEmptyResponseNudgeStoreForTests();
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

  test("keeps a continued output-limit response private", async () => {
    // The first response stops at max_tokens; the default max-tokens-continue
    // plugin resumes the turn, so that truncated half-sentence is still
    // working notes. Only the message the resumed run sends reaches the user.
    const { provider } = createMockProvider([
      {
        content: [
          { type: "text", text: "Half a scratchpad sentence that got cut" },
        ] as ContentBlock[],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "max_tokens",
      },
      textAndSend("Done thinking.", "You have two meetings today.", "tu_1"),
      textResponse("Wrapping up."),
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

    expect(streamedText(events)).toBe("You have two meetings today.");
    expect(streamedText(events)).not.toContain("scratchpad");
    // Every row of the run stays private: the truncated one because the run
    // continued, the rest because the tool carried the reply.
    expect(visibilityMarks(events).every((v) => v === "private")).toBe(true);
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

describe("a send_user_message call that delivers nothing", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
    // The nudge is one-shot per conversation and every case here shares one
    // id, so without this the first suppressed run consumes it for the file.
    resetEmptyResponseNudgeStoreForTests();
  });

  /** A call the executor rejects: the name is right, the message is not. */
  function blankSend(message: unknown, id = "tu_blank"): ProviderResponse {
    return {
      content: [
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

  test("does not count as having told the user, so the fallback still fires", async () => {
    // The blank call streams nothing. If it counted as delivery, the nudge
    // retry's plain text would be suppressed too and the user would be left
    // with no reply at all.
    const { provider } = createMockProvider([
      blankSend("   "),
      textResponse("Two meetings today."),
      textResponse("Two meetings today."),
    ]);
    const events: AgentEvent[] = [];
    await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust,
      suppressAssistantText: true,
    });

    expect(streamedText(events)).toContain("Two meetings today.");
  });

  test("a non-string message is treated the same way", async () => {
    const { provider } = createMockProvider([
      blankSend(42),
      textResponse("Two meetings today."),
      textResponse("Two meetings today."),
    ]);
    const events: AgentEvent[] = [];
    await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust,
      suppressAssistantText: true,
    });

    expect(streamedText(events)).toContain("Two meetings today.");
  });

  test("one usable and one blank call in a response is not an outcome", async () => {
    // The loop counts an outcome only when EVERY call delivered, and the hook
    // now reads that same answer off the context. Counting the response as a
    // report would suppress the fallback on the terminal turn, so the user
    // would get "Looking now." and never the result.
    const { provider, calls } = createMockProvider([
      {
        content: [
          {
            type: "tool_use",
            id: "tu_ok",
            name: "send_user_message",
            input: { message: "Looking now." },
          },
          {
            type: "tool_use",
            id: "tu_blank",
            name: "send_user_message",
            input: { message: "  " },
          },
        ] as ContentBlock[],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      textResponse("Two meetings today."),
      textResponse("Two meetings today."),
    ]);
    const events: AgentEvent[] = [];
    await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust,
      suppressAssistantText: true,
      // The nudge is main-agent only, so the plugin's half of the contract is
      // only observable on that call site.
      callSite: "mainAgent",
    });

    // Three provider calls: the mixed response, the nudge retry, and the turn
    // that ends. A hook reading the mixed response as a report would skip the
    // nudge and the run would stop at two.
    expect(calls).toHaveLength(3);
    expect(streamedText(events)).toContain("Two meetings today.");
  });

  test("a usable call still counts, so its turn stays private", async () => {
    const { provider } = createMockProvider([
      textAndSend("thinking", "Two meetings today."),
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

    expect(streamedText(events)).toBe("Two meetings today.");
  });
});

/**
 * The shape live QA hit: a turn answers with one `send_user_message` call and
 * then returns an empty response because it has nothing more to say.
 *
 * That is the turn ending correctly. Before the fix the gated branch was
 * skipped (the user HAD been told), execution fell through to the legacy
 * empty-turn nudge, and the model got a system notice telling it to "respond
 * with text", which the gate makes invisible. It answered the notice in raw
 * text, costing a model call and leaving a duplicate private row.
 */
describe("an empty response after the reply was delivered", () => {
  const sendOnly = (message: string): ProviderResponse => ({
    content: [
      {
        type: "tool_use",
        id: "tu_1",
        name: "send_user_message",
        input: { message },
      },
    ] as ContentBlock[],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "tool_use",
  });

  const emptyResponse = (): ProviderResponse => ({
    content: [] as ContentBlock[],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 0 },
    stopReason: "end_turn",
  });

  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
    resetEmptyResponseNudgeStoreForTests();
  });

  test("ends the turn without any nudge", async () => {
    const { provider, calls } = createMockProvider([
      sendOnly("vizgrid. what's up?"),
      emptyResponse(),
    ]);
    const events: AgentEvent[] = [];
    const { history } = await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust,
      suppressAssistantText: true,
      callSite: "mainAgent",
    });

    // Exactly the two scripted calls: no retry was asked for.
    expect(calls).toHaveLength(2);
    const historyText = JSON.stringify(history);
    expect(historyText).not.toContain(SEND_USER_MESSAGE_NUDGE_TEXT);
    expect(historyText).not.toContain(NUDGE_TEXT);
    // The delivered message is what reached the user, once.
    expect(streamedText(events)).toBe("vizgrid. what's up?");
  });

  test("still nudges when the turn ended without delivering", async () => {
    // The other side of the same branch: nothing reached the user, so the
    // gated nudge fires and it is the gated wording, not the flag-off one.
    const { provider, calls } = createMockProvider([
      {
        content: [
          { type: "tool_use", id: "tu_w", name: "bash", input: {} },
        ] as ContentBlock[],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      emptyResponse(),
      emptyResponse(),
    ]);
    const { history } = await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust,
      suppressAssistantText: true,
      callSite: "mainAgent",
    });

    expect(calls.length).toBeGreaterThan(2);
    const historyText = JSON.stringify(history);
    expect(historyText).toContain(SEND_USER_MESSAGE_NUDGE_TEXT);
    // The flag-off wording must never reach a gated run.
    expect(historyText).not.toContain(NUDGE_TEXT);
  });
});

/**
 * The terminal (no-tool) dispatch is the one the gated branch acts on, so the
 * context it carries has to describe the run.
 */
describe("the post-model-call context on a terminal response", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
    resetEmptyResponseNudgeStoreForTests();
  });

  test("carries assistantTextSuppressed and the outcome the loop computed", async () => {
    const seen: Array<{
      suppressed: boolean | undefined;
      told: boolean | undefined;
      hasTool: boolean;
    }> = [];
    registerPlugin({
      manifest: { name: "test-terminal-ctx", version: "0.0.0" },
      hooks: {
        "post-model-call": async (ctx: PostModelCallContext) => {
          seen.push({
            suppressed: ctx.assistantTextSuppressed,
            told: ctx.userToldOutcome,
            hasTool: ctx.content.some((b) => b.type === "tool_use"),
          });
        },
      },
    });

    const { provider } = createMockProvider([
      {
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "send_user_message",
            input: { message: "vizgrid. what's up?" },
          },
        ] as ContentBlock[],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      {
        content: [] as ContentBlock[],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 0 },
        stopReason: "end_turn",
      },
    ]);
    await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust,
      suppressAssistantText: true,
      callSite: "mainAgent",
    });

    const terminal = seen.filter((entry) => !entry.hasTool).at(-1);
    expect(terminal).toBeDefined();
    expect(terminal?.suppressed).toBe(true);
    // Computed over the run, not the empty response in hand: the last
    // tool-bearing response delivered, so the user has the answer.
    expect(terminal?.told).toBe(true);
  });
});

/**
 * Nothing of the model's reasoning streams to the client under the gate.
 *
 * Demoting it (or forwarding the deltas) put a "Thinking" row above every
 * delivered message. The reasoning stays in history and in the persisted row
 * for resume and the inspector; the turn's activity-state transitions are what
 * tell the client work is happening.
 */
describe("thinking under the tool-gated reply surface", () => {
  const thinkAndSend = (
    thought: string,
    message: string,
  ): ProviderResponse => ({
    content: [
      { type: "thinking", thinking: thought, signature: "sig" },
      { type: "text", text: "private notes" },
      {
        type: "tool_use",
        id: "tu_1",
        name: "send_user_message",
        input: { message },
      },
    ] as ContentBlock[],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "tool_use",
  });

  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
    resetEmptyResponseNudgeStoreForTests();
  });

  test("a gated turn streams no thinking deltas", async () => {
    const { provider } = createMockProvider([
      thinkAndSend("reasoning at length", "Two meetings today."),
      textResponse("done"),
    ]);
    const events: AgentEvent[] = [];
    await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust,
      suppressAssistantText: true,
      callSite: "mainAgent",
    });

    expect(events.filter((e) => e.type === "thinking_delta")).toEqual([]);
    expect(streamedText(events)).toBe("Two meetings today.");
    // The loop's own `message_complete` still carries the raw content: that is
    // what the daemon persists. Nothing of it reaches a client, because the
    // SSE `message_complete` carries ids and the visibility marker only, and
    // the history refetch behind it is projected.
    const complete = events.find((e) => e.type === "message_complete");
    expect(JSON.stringify(complete)).toContain("reasoning at length");
  });

  test("an ordinary run still streams them", async () => {
    const { provider } = createMockProvider([
      thinkAndSend("reasoning at length", "ignored without the gate"),
      textResponse("done"),
    ]);
    const events: AgentEvent[] = [];
    await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust,
    });

    expect(
      events.filter((e) => e.type === "thinking_delta").length,
    ).toBeGreaterThan(0);
  });
});

describe("several messages in one response", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
    resetEmptyResponseNudgeStoreForTests();
  });

  test("stream as paragraphs, matching what a reload renders", async () => {
    // Joined with a space they collapsed onto one line the moment the turn
    // completed and the row re-rendered from the persisted projection.
    const { provider } = createMockProvider([
      {
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "send_user_message",
            input: { message: "message one" },
          },
          {
            type: "tool_use",
            id: "tu_2",
            name: "send_user_message",
            input: { message: "message two" },
          },
          {
            type: "tool_use",
            id: "tu_3",
            name: "send_user_message",
            input: { message: "message three" },
          },
        ] as ContentBlock[],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      textResponse("done"),
    ]);
    const events: AgentEvent[] = [];
    await loopWith(provider).run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: collect(events),
      trust,
      suppressAssistantText: true,
      callSite: "mainAgent",
    });

    expect(streamedText(events)).toBe(
      "message one\n\nmessage two\n\nmessage three",
    );
  });
});
