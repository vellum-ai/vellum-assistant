import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  ProviderResponse,
  SendMessageOptions,
} from "../../../providers/types.js";
import type { ToolContext } from "../../types.js";

// ── Silence the logger ─────────────────────────────────────────────────
mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Mutable mock state ─────────────────────────────────────────────────
// `mockMessages` stands in for the live conversation's transcript;
// `conversationExists` toggles the registry lookup. `providerResult`
// controls what `getConfiguredProvider` returns; `sendMessageImpl` lets a
// test stub the provider response or throw.

let mockMessages: Message[] = [];
let conversationExists = true;

let providerResult: { sendMessage: typeof sendMessageMock } | null = null;
let lastSendMessages: Message[] | null = null;
let lastSendOptions: SendMessageOptions | undefined;

let sendMessageImpl: (
  messages: Message[],
  options?: SendMessageOptions,
) => Promise<ProviderResponse> = async () => textResponse("default advice");

const sendMessageMock = mock(
  (messages: Message[], options?: SendMessageOptions) => {
    lastSendMessages = messages;
    lastSendOptions = options;
    return sendMessageImpl(messages, options);
  },
);

mock.module("../../../daemon/conversation-registry.js", () => ({
  findConversation: () =>
    conversationExists ? { messages: mockMessages } : undefined,
}));

// Spread the real module so `extractAllText` (also imported by consult.ts)
// keeps its production implementation; only `getConfiguredProvider` is stubbed.
const realProviderSend = await import(
  "../../../providers/provider-send-message.js"
);
mock.module("../../../providers/provider-send-message.js", () => ({
  ...realProviderSend,
  getConfiguredProvider: async () => providerResult,
}));

// Imports AFTER mocks so the mocked modules are picked up.
const { executeAdvisorConsult } = await import("../consult.js");

// ── Helpers ────────────────────────────────────────────────────────────

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "end_turn",
  };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: "conv-1",
    workingDir: "/tmp",
    trustClass: "guardian",
    ...overrides,
  };
}

function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

beforeEach(() => {
  mockMessages = [];
  conversationExists = true;
  providerResult = { sendMessage: sendMessageMock };
  lastSendMessages = null;
  lastSendOptions = undefined;
  sendMessageImpl = async () => textResponse("default advice");
  sendMessageMock.mockClear();
});

describe("executeAdvisorConsult", () => {
  test("happy path: sanitizes transcript, appends focus nudge, sends one tool-less advisor call", async () => {
    // A completed turn plus a DANGLING tool_use the sanitizer must drop.
    mockMessages = [
      userText("Build the feature"),
      {
        role: "assistant",
        content: [{ type: "text", text: "On it." }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "dangling-1", name: "bash", input: {} },
        ],
      },
    ];
    sendMessageImpl = async () => textResponse("Do X before Y.");

    const result = await executeAdvisorConsult({}, makeContext());

    expect(result).toEqual({ content: "Do X before Y.", isError: false });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    const sent = lastSendMessages ?? [];
    // (a) sanitizer ran — the dangling tool_use is gone.
    const hasDangling = sent.some((m) =>
      m.content.some(
        (b) => b.type === "tool_use" && b.id === "dangling-1",
      ),
    );
    expect(hasDangling).toBe(false);

    // (b) ends with the advisor's trailing user turn carrying the nudge.
    const last = sent[sent.length - 1];
    expect(last.role).toBe("user");
    const lastText =
      last.content[0]?.type === "text" ? last.content[0].text : "";
    expect(lastText).toContain("Review the work so far");
    expect(lastText).toContain("under ~120 words");

    // (c) no tools, correct call site.
    expect(lastSendOptions?.tools).toBeUndefined();
    expect(lastSendOptions?.config?.callSite).toBe("advisor");
    expect(lastSendOptions?.systemPrompt).toBeTruthy();
  });

  test("focus provided: it appears in the trailing user message", async () => {
    mockMessages = [userText("Working on auth")];

    await executeAdvisorConsult(
      { focus: "Is the token refresh logic safe?" },
      makeContext(),
    );

    const sent = lastSendMessages ?? [];
    const last = sent[sent.length - 1];
    const lastText =
      last.content[0]?.type === "text" ? last.content[0].text : "";
    expect(lastText).toContain("Is the token refresh logic safe?");
    expect(lastText).toContain("under ~120 words");
  });

  test("no provider configured: returns higher-tier message, never calls sendMessage", async () => {
    mockMessages = [userText("hi")];
    providerResult = null;

    const result = await executeAdvisorConsult({}, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("no higher-tier model");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("no conversation: degrades without throwing or calling sendMessage", async () => {
    conversationExists = false;

    const result = await executeAdvisorConsult({}, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("conversation could not be resolved");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("empty transcript: nothing to advise on", async () => {
    mockMessages = [];

    const result = await executeAdvisorConsult({}, makeContext());

    expect(result).toEqual({
      content: "Nothing to advise on yet.",
      isError: false,
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("sendMessage throws: degrades as isError:false and does not throw", async () => {
    mockMessages = [userText("hi")];
    sendMessageImpl = async () => {
      throw new Error("provider exploded");
    };

    const result = await executeAdvisorConsult({}, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Advisor consult failed");
    expect(result.content).toContain("provider exploded");
  });

  test("empty advice: returns the no-guidance message", async () => {
    mockMessages = [userText("hi")];
    sendMessageImpl = async () => textResponse("   ");

    const result = await executeAdvisorConsult({}, makeContext());

    expect(result).toEqual({
      content: "Advisor returned no guidance.",
      isError: false,
    });
  });
});
