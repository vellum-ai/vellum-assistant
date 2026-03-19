import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Provider, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on them
// ---------------------------------------------------------------------------

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

const mockSendMessage = mock<Provider["sendMessage"]>();
const mockProvider: Provider = {
  name: "mock-reducer-provider",
  sendMessage: mockSendMessage,
};

let providerAvailable = true;

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => (providerAvailable ? mockProvider : null),
  createTimeout: (ms: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    };
  },
  extractText: (response: ProviderResponse) => {
    const block = response.content.find(
      (b): b is Extract<(typeof response.content)[number], { type: "text" }> =>
        b.type === "text",
    );
    return block?.text?.trim() ?? "";
  },
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import {
  buildReducerSystemPrompt,
  buildReducerUserMessage,
  type ReducerPromptInput,
  runReducer,
} from "../memory/reducer.js";
import { EMPTY_REDUCER_RESULT } from "../memory/reducer-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(
  overrides: Partial<ReducerPromptInput> = {},
): ReducerPromptInput {
  return {
    conversationId: "conv-test-1",
    newMessages: [
      { role: "user", content: "I'm traveling to Paris next week." },
      {
        role: "assistant",
        content: "That sounds exciting! Do you need help planning?",
      },
    ],
    existingTimeContexts: [],
    existingOpenLoops: [],
    nowMs: 1700000000000,
    scopeId: "scope-default",
    ...overrides,
  };
}

function makeProviderResponse(jsonOutput: unknown): ProviderResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(jsonOutput) }],
    model: "mock-model",
    usage: { inputTokens: 100, outputTokens: 50 },
    stopReason: "end_turn",
  };
}

// ---------------------------------------------------------------------------
// Tests: buildReducerSystemPrompt
// ---------------------------------------------------------------------------

describe("buildReducerSystemPrompt", () => {
  test("contains key structural instructions", () => {
    const prompt = buildReducerSystemPrompt();
    expect(prompt).toContain("timeContexts");
    expect(prompt).toContain("openLoops");
    expect(prompt).toContain("archiveObservations");
    expect(prompt).toContain("archiveEpisodes");
    expect(prompt).toContain("JSON");
  });
});

// ---------------------------------------------------------------------------
// Tests: buildReducerUserMessage
// ---------------------------------------------------------------------------

describe("buildReducerUserMessage", () => {
  test("includes current time, conversation ID, and scope", () => {
    const input = makeInput();
    const msg = buildReducerUserMessage(input);
    expect(msg).toContain("conv-test-1");
    expect(msg).toContain("scope-default");
    expect(msg).toContain("1700000000000");
  });

  test("includes new messages", () => {
    const input = makeInput();
    const msg = buildReducerUserMessage(input);
    expect(msg).toContain("[user]: I'm traveling to Paris next week.");
    expect(msg).toContain("[assistant]: That sounds exciting!");
  });

  test("includes existing time contexts when provided", () => {
    const input = makeInput({
      existingTimeContexts: [
        { id: "tc-1", summary: "User on vacation until Friday" },
      ],
    });
    const msg = buildReducerUserMessage(input);
    expect(msg).toContain("Active time contexts");
    expect(msg).toContain("[tc-1] User on vacation until Friday");
  });

  test("includes existing open loops when provided", () => {
    const input = makeInput({
      existingOpenLoops: [
        { id: "ol-1", summary: "Follow up with Bob", status: "open" },
      ],
    });
    const msg = buildReducerUserMessage(input);
    expect(msg).toContain("Active open loops");
    expect(msg).toContain("[ol-1] (open) Follow up with Bob");
  });

  test("omits time context section when none exist", () => {
    const input = makeInput({ existingTimeContexts: [] });
    const msg = buildReducerUserMessage(input);
    expect(msg).not.toContain("Active time contexts");
  });

  test("omits open loop section when none exist", () => {
    const input = makeInput({ existingOpenLoops: [] });
    const msg = buildReducerUserMessage(input);
    expect(msg).not.toContain("Active open loops");
  });
});

// ---------------------------------------------------------------------------
// Tests: runReducer — event extraction
// ---------------------------------------------------------------------------

describe("runReducer — event extraction", () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    providerAvailable = true;
  });

  test("extracts archive observations from provider response", async () => {
    mockSendMessage.mockResolvedValueOnce(
      makeProviderResponse({
        archiveObservations: [
          {
            content: "User is planning a trip to Paris",
            role: "user",
            modality: "text",
            source: "vellum",
          },
          {
            content: "User prefers window seats on flights",
            role: "user",
          },
        ],
      }),
    );

    const result = await runReducer(makeInput());

    expect(result.archiveObservations).toHaveLength(2);
    expect(result.archiveObservations[0]).toEqual({
      content: "User is planning a trip to Paris",
      role: "user",
      modality: "text",
      source: "vellum",
    });
    expect(result.archiveObservations[1]).toEqual({
      content: "User prefers window seats on flights",
      role: "user",
    });
  });

  test("extracts archive episodes from provider response", async () => {
    mockSendMessage.mockResolvedValueOnce(
      makeProviderResponse({
        archiveEpisodes: [
          {
            title: "Paris trip planning",
            summary:
              "User discussed upcoming trip to Paris, mentioned interest in museums.",
            source: "vellum",
          },
        ],
      }),
    );

    const result = await runReducer(makeInput());

    expect(result.archiveEpisodes).toHaveLength(1);
    expect(result.archiveEpisodes[0]).toEqual({
      title: "Paris trip planning",
      summary:
        "User discussed upcoming trip to Paris, mentioned interest in museums.",
      source: "vellum",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: runReducer — temporary situation extraction
// ---------------------------------------------------------------------------

describe("runReducer — temporary situation extraction", () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    providerAvailable = true;
  });

  test("extracts time context create operations", async () => {
    mockSendMessage.mockResolvedValueOnce(
      makeProviderResponse({
        timeContexts: [
          {
            action: "create",
            summary: "User traveling to Paris next week",
            source: "conversation",
            activeFrom: 1700000000000,
            activeUntil: 1700604800000,
          },
        ],
      }),
    );

    const result = await runReducer(makeInput());

    expect(result.timeContexts).toHaveLength(1);
    expect(result.timeContexts[0]).toEqual({
      action: "create",
      summary: "User traveling to Paris next week",
      source: "conversation",
      activeFrom: 1700000000000,
      activeUntil: 1700604800000,
    });
  });

  test("extracts time context update operations referencing existing IDs", async () => {
    mockSendMessage.mockResolvedValueOnce(
      makeProviderResponse({
        timeContexts: [
          {
            action: "update",
            id: "tc-existing-1",
            summary: "Trip extended to two weeks",
            activeUntil: 1701209600000,
          },
        ],
      }),
    );

    const result = await runReducer(
      makeInput({
        existingTimeContexts: [
          { id: "tc-existing-1", summary: "User traveling next week" },
        ],
      }),
    );

    expect(result.timeContexts).toHaveLength(1);
    expect(result.timeContexts[0]).toEqual({
      action: "update",
      id: "tc-existing-1",
      summary: "Trip extended to two weeks",
      activeUntil: 1701209600000,
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: runReducer — open-loop creation
// ---------------------------------------------------------------------------

describe("runReducer — open-loop creation", () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    providerAvailable = true;
  });

  test("extracts open loop create operations", async () => {
    mockSendMessage.mockResolvedValueOnce(
      makeProviderResponse({
        openLoops: [
          {
            action: "create",
            summary: "Book hotel in Paris",
            source: "conversation",
            dueAt: 1700172800000,
          },
        ],
      }),
    );

    const result = await runReducer(makeInput());

    expect(result.openLoops).toHaveLength(1);
    expect(result.openLoops[0]).toEqual({
      action: "create",
      summary: "Book hotel in Paris",
      source: "conversation",
      dueAt: 1700172800000,
    });
  });

  test("extracts open loop create without optional dueAt", async () => {
    mockSendMessage.mockResolvedValueOnce(
      makeProviderResponse({
        openLoops: [
          {
            action: "create",
            summary: "Research museums in Paris",
            source: "conversation",
          },
        ],
      }),
    );

    const result = await runReducer(makeInput());

    expect(result.openLoops).toHaveLength(1);
    const op = result.openLoops[0];
    expect(op.action).toBe("create");
    if (op.action === "create") {
      expect(op.summary).toBe("Research museums in Paris");
      expect(op.dueAt).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: runReducer — explicit resolution
// ---------------------------------------------------------------------------

describe("runReducer — explicit resolution", () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    providerAvailable = true;
  });

  test("extracts time context resolve operations", async () => {
    mockSendMessage.mockResolvedValueOnce(
      makeProviderResponse({
        timeContexts: [
          {
            action: "resolve",
            id: "tc-old-1",
          },
        ],
      }),
    );

    const result = await runReducer(
      makeInput({
        existingTimeContexts: [
          { id: "tc-old-1", summary: "Conference this week" },
        ],
      }),
    );

    expect(result.timeContexts).toHaveLength(1);
    expect(result.timeContexts[0]).toEqual({
      action: "resolve",
      id: "tc-old-1",
    });
  });

  test("extracts open loop resolve with 'resolved' status", async () => {
    mockSendMessage.mockResolvedValueOnce(
      makeProviderResponse({
        openLoops: [
          {
            action: "resolve",
            id: "ol-done-1",
            status: "resolved",
          },
        ],
      }),
    );

    const result = await runReducer(
      makeInput({
        existingOpenLoops: [
          { id: "ol-done-1", summary: "Send report to Alice", status: "open" },
        ],
      }),
    );

    expect(result.openLoops).toHaveLength(1);
    expect(result.openLoops[0]).toEqual({
      action: "resolve",
      id: "ol-done-1",
      status: "resolved",
    });
  });

  test("extracts open loop resolve with 'expired' status", async () => {
    mockSendMessage.mockResolvedValueOnce(
      makeProviderResponse({
        openLoops: [
          {
            action: "resolve",
            id: "ol-expired-1",
            status: "expired",
          },
        ],
      }),
    );

    const result = await runReducer(
      makeInput({
        existingOpenLoops: [
          {
            id: "ol-expired-1",
            summary: "RSVP deadline passed",
            status: "open",
          },
        ],
      }),
    );

    expect(result.openLoops).toHaveLength(1);
    expect(result.openLoops[0]).toEqual({
      action: "resolve",
      id: "ol-expired-1",
      status: "expired",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: runReducer — provider unavailable / error handling
// ---------------------------------------------------------------------------

describe("runReducer — error handling", () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    providerAvailable = true;
  });

  test("returns EMPTY_REDUCER_RESULT when no provider is available", async () => {
    providerAvailable = false;

    const result = await runReducer(makeInput());

    expect(result).toBe(EMPTY_REDUCER_RESULT);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test("returns EMPTY_REDUCER_RESULT when provider throws", async () => {
    mockSendMessage.mockRejectedValueOnce(new Error("Provider error"));

    const result = await runReducer(makeInput());

    expect(result).toBe(EMPTY_REDUCER_RESULT);
  });

  test("returns EMPTY_REDUCER_RESULT when provider returns empty text", async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: "text", text: "" }],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 0 },
      stopReason: "end_turn",
    });

    const result = await runReducer(makeInput());

    expect(result).toBe(EMPTY_REDUCER_RESULT);
  });

  test("returns EMPTY_REDUCER_RESULT when provider returns invalid JSON", async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: "text", text: "not valid json at all" }],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn",
    });

    const result = await runReducer(makeInput());

    expect(result).toBe(EMPTY_REDUCER_RESULT);
  });

  test("returns EMPTY_REDUCER_RESULT when provider returns empty object", async () => {
    mockSendMessage.mockResolvedValueOnce(makeProviderResponse({}));

    const result = await runReducer(makeInput());

    expect(result).toBe(EMPTY_REDUCER_RESULT);
  });
});

// ---------------------------------------------------------------------------
// Tests: runReducer — provider call arguments
// ---------------------------------------------------------------------------

describe("runReducer — provider call arguments", () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    providerAvailable = true;
    mockSendMessage.mockResolvedValue(makeProviderResponse({}));
  });

  test("sends messages with correct structure", async () => {
    await runReducer(makeInput());

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [messages] = mockSendMessage.mock.calls[0] as Parameters<
      Provider["sendMessage"]
    >;

    // Should be a single user message
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toHaveLength(1);
    expect(messages[0].content[0].type).toBe("text");
  });

  test("does not send any tool definitions", async () => {
    await runReducer(makeInput());

    const [, tools] = mockSendMessage.mock.calls[0] as Parameters<
      Provider["sendMessage"]
    >;
    expect(tools).toBeUndefined();
  });

  test("sends a system prompt", async () => {
    await runReducer(makeInput());

    const [, , systemPrompt] = mockSendMessage.mock.calls[0] as Parameters<
      Provider["sendMessage"]
    >;
    expect(systemPrompt).toBeTruthy();
    expect(typeof systemPrompt).toBe("string");
  });

  test("uses latency-optimized model intent", async () => {
    await runReducer(makeInput());

    const [, , , options] = mockSendMessage.mock.calls[0] as Parameters<
      Provider["sendMessage"]
    >;
    expect(options?.config?.modelIntent).toBe("latency-optimized");
  });

  test("passes abort signal to provider", async () => {
    await runReducer(makeInput());

    const [, , , options] = mockSendMessage.mock.calls[0] as Parameters<
      Provider["sendMessage"]
    >;
    expect(options?.signal).toBeDefined();
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// Tests: runReducer — side-effect-free guarantee
// ---------------------------------------------------------------------------

describe("runReducer — side-effect-free", () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    providerAvailable = true;
  });

  test("returns typed result without performing any writes", async () => {
    const fullResponse = {
      timeContexts: [
        {
          action: "create",
          summary: "Paris trip",
          source: "conversation",
          activeFrom: 1700000000000,
          activeUntil: 1700604800000,
        },
      ],
      openLoops: [
        {
          action: "create",
          summary: "Book hotel",
          source: "conversation",
        },
      ],
      archiveObservations: [
        {
          content: "User likes museums",
          role: "user",
        },
      ],
      archiveEpisodes: [
        {
          title: "Trip planning",
          summary: "Discussed Paris trip",
        },
      ],
    };

    mockSendMessage.mockResolvedValueOnce(makeProviderResponse(fullResponse));

    const result = await runReducer(makeInput());

    // Verify the result is correctly typed and populated
    expect(result.timeContexts).toHaveLength(1);
    expect(result.openLoops).toHaveLength(1);
    expect(result.archiveObservations).toHaveLength(1);
    expect(result.archiveEpisodes).toHaveLength(1);

    // The function only called sendMessage — no other side effects
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  test("handles mixed valid and invalid operations gracefully", async () => {
    mockSendMessage.mockResolvedValueOnce(
      makeProviderResponse({
        timeContexts: [
          // valid
          {
            action: "create",
            summary: "Valid context",
            source: "conversation",
            activeFrom: 1000,
            activeUntil: 2000,
          },
          // invalid — missing summary
          {
            action: "create",
            source: "conversation",
            activeFrom: 1000,
            activeUntil: 2000,
          },
        ],
        openLoops: [
          // valid
          {
            action: "create",
            summary: "Valid loop",
            source: "conversation",
          },
          // invalid — missing source
          { action: "create", summary: "Bad loop" },
        ],
      }),
    );

    const result = await runReducer(makeInput());

    // Only valid operations should be present
    expect(result.timeContexts).toHaveLength(1);
    expect(result.timeContexts[0].action).toBe("create");
    expect(result.openLoops).toHaveLength(1);
    expect(result.openLoops[0].action).toBe("create");
  });
});
