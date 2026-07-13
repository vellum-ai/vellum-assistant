/**
 * Explicit prompt-cache breakpoint placement for GPT-5.6+ on the OpenAI
 * Responses transport: request-wide `prompt_cache_options`/`prompt_cache_key`
 * emission, block-level `prompt_cache_breakpoint` anchor placement (turn-start
 * / previous-turn / advancing tail, mirroring the Anthropic client), the
 * `disableCache` explicit-mode-with-zero-markers opt-out, and the unflagged-
 * model regression guard.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock openai module — must be before importing the provider
// ---------------------------------------------------------------------------

interface FakeStreamEvent {
  type: string;
  [key: string]: unknown;
}

let fakeStreamEvents: FakeStreamEvent[] = [];
let lastStreamParams: Record<string, unknown> | null = null;

mock.module("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: async (params: Record<string, unknown>) => {
        lastStreamParams = params;
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const event of fakeStreamEvents) {
              yield event;
            }
          },
        };
      },
    };
  },
}));

// Import after mocking
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { OpenAIResponsesProvider } from "../providers/openai/responses-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textDeltaEvent(delta: string): FakeStreamEvent {
  return { type: "response.output_text.delta", delta };
}

function completedEvent(): FakeStreamEvent {
  return {
    type: "response.completed",
    response: {
      model: "gpt-5.6-sol",
      status: "completed",
      output: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolUseMsg(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

function toolResultMsg(toolUseId: string, content: string): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
  };
}

type WireItem = {
  type?: string;
  role?: string;
  content?: Array<Record<string, unknown>>;
};

/** Indexes of wire input items carrying a `prompt_cache_breakpoint` marker. */
function breakpointedItemIndexes(): number[] {
  const input = (lastStreamParams?.input ?? []) as WireItem[];
  const marked: number[] = [];
  input.forEach((item, idx) => {
    if (item.content?.some((p) => p.prompt_cache_breakpoint !== undefined)) {
      marked.push(idx);
    }
  });
  return marked;
}

function makeProvider(model: string, codexSubscription = false) {
  return new OpenAIResponsesProvider("sk-test", model, { codexSubscription });
}

beforeEach(() => {
  fakeStreamEvents = [textDeltaEvent("ok"), completedEvent()];
  lastStreamParams = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAIResponsesProvider explicit prompt caching (GPT-5.6+)", () => {
  test("first turn: explicit mode, key, and a turn-start anchor", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    await provider.sendMessage([userMsg("hi")], {
      config: { promptCacheKey: "conv-1" },
    });

    expect(lastStreamParams?.prompt_cache_options).toEqual({
      mode: "explicit",
    });
    expect(lastStreamParams?.prompt_cache_key).toBe("conv-1");
    expect(breakpointedItemIndexes()).toEqual([0]);
  });

  test("multi-turn: every user message is marked (the anchor ladder)", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    await provider.sendMessage(
      [userMsg("t1"), assistantMsg("r1"), userMsg("t2")],
      { config: { promptCacheKey: "conv-1" } },
    );

    // Wire items: [user t1, assistant r1, user t2]. Reads only consider
    // markers in the current request, so historical boundaries must be
    // re-marked every turn for their cached prefixes to stay reachable.
    expect(breakpointedItemIndexes()).toEqual([0, 2]);
  });

  test("longer history: the ladder marks all user messages", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    await provider.sendMessage(
      [
        userMsg("t1"),
        assistantMsg("r1"),
        userMsg("t2"),
        assistantMsg("r2"),
        userMsg("t3"),
      ],
      { config: { promptCacheKey: "conv-1" } },
    );

    expect(breakpointedItemIndexes()).toEqual([0, 2, 4]);
  });

  test("marker ladder caps at 50 boundaries, dropping the oldest", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    const messages: Message[] = [];
    for (let i = 0; i < 55; i++) {
      messages.push(userMsg(`t${i}`));
      messages.push(assistantMsg(`r${i}`));
    }
    await provider.sendMessage(messages, {
      config: { promptCacheKey: "conv-1" },
    });

    const marked = breakpointedItemIndexes();
    expect(marked).toHaveLength(50);
    // User items sit at even indexes; the 5 oldest (0..8) fall off the ladder.
    expect(marked[0]).toBe(10);
    expect(marked[marked.length - 1]).toBe(108);
  });

  test("volatile latest message: the previous stable user message stays reachable, the latest is prepaid", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    await provider.sendMessage(
      [userMsg("t1"), assistantMsg("r1"), userMsg("t2 + <memory>")],
      { config: { mutableLatestUserMessage: true, promptCacheKey: "conv-1" } },
    );

    // Item 0 is the durable cross-turn boundary (next turn re-marks it and
    // reads its prefix); marking the volatile latest item prepays its write
    // so in-turn tool iterations read it.
    expect(breakpointedItemIndexes()).toEqual([0, 2]);
  });

  test("volatile single-message first turn: no markers (nothing stable to anchor)", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    await provider.sendMessage([userMsg("hi")], {
      config: { mutableLatestUserMessage: true, promptCacheKey: "conv-1" },
    });

    expect(lastStreamParams?.prompt_cache_options).toEqual({
      mode: "explicit",
    });
    expect(breakpointedItemIndexes()).toEqual([]);
  });

  test("tool loop: single fixed anchor on the turn-start user item, none on function_call_output", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    await provider.sendMessage(
      [
        userMsg("read the file"),
        toolUseMsg("call_1", "read"),
        toolResultMsg("call_1", "contents"),
      ],
      { config: { promptCacheKey: "conv-1" } },
    );

    // Wire items: [user message, function_call, function_call_output]. Tool
    // outputs cannot carry markers, so the only user-text item is the sole
    // rung on the ladder.
    const input = (lastStreamParams?.input ?? []) as WireItem[];
    expect(input.map((i) => i.type)).toEqual([
      "message",
      "function_call",
      "function_call_output",
    ]);
    expect(breakpointedItemIndexes()).toEqual([0]);
    expect(JSON.stringify(input[2])).not.toContain("prompt_cache_breakpoint");
  });

  test("tool loop with trailing user text: the reminder item joins the ladder", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    const reminderTurn: Message = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "contents" },
        { type: "text", text: "[System reminder]" },
      ],
    };
    await provider.sendMessage(
      [userMsg("read the file"), toolUseMsg("call_1", "read"), reminderTurn],
      { config: { promptCacheKey: "conv-1" } },
    );

    // Wire items: [message, function_call, function_call_output,
    // message(reminder)] — both user-text items are marked.
    expect(breakpointedItemIndexes()).toEqual([0, 3]);
  });

  test("disableCache: explicit mode with zero markers", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    await provider.sendMessage(
      [userMsg("t1"), assistantMsg("r1"), userMsg("t2")],
      { config: { disableCache: true, promptCacheKey: "conv-1" } },
    );

    // Explicit mode with no breakpoints = no cache use and no write charges.
    // Omitting prompt_cache_options would re-enable implicit mode instead.
    expect(lastStreamParams?.prompt_cache_options).toEqual({
      mode: "explicit",
    });
    expect(breakpointedItemIndexes()).toEqual([]);
  });

  test("disableTurnStartCache multi-turn: suppresses only the newest marker", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    await provider.sendMessage(
      [userMsg("t1"), assistantMsg("r1"), userMsg("t2")],
      { config: { disableTurnStartCache: true, promptCacheKey: "conv-1" } },
    );

    expect(breakpointedItemIndexes()).toEqual([0]);
  });

  test("disableTurnStartCache one-shot: no markers", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    await provider.sendMessage([userMsg("one-shot")], {
      config: { disableTurnStartCache: true, promptCacheKey: "conv-1" },
    });

    expect(lastStreamParams?.prompt_cache_options).toEqual({
      mode: "explicit",
    });
    expect(breakpointedItemIndexes()).toEqual([]);
  });

  test("prompt_cache_key omitted when absent; markers still stamped", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    await provider.sendMessage([userMsg("hi")]);

    expect(lastStreamParams?.prompt_cache_options).toEqual({
      mode: "explicit",
    });
    expect(lastStreamParams?.prompt_cache_key).toBeUndefined();
    expect(breakpointedItemIndexes()).toEqual([0]);
  });

  test("unflagged model sends no cache params at all", async () => {
    const provider = makeProvider("gpt-5.5");
    await provider.sendMessage(
      [userMsg("t1"), assistantMsg("r1"), userMsg("t2")],
      { config: { mutableLatestUserMessage: true, promptCacheKey: "conv-1" } },
    );

    expect(lastStreamParams?.prompt_cache_options).toBeUndefined();
    expect(lastStreamParams?.prompt_cache_key).toBeUndefined();
    expect(JSON.stringify(lastStreamParams?.input)).not.toContain(
      "prompt_cache_breakpoint",
    );
  });

  test("model override gates on the effective model, not the constructor model", async () => {
    const provider = makeProvider("gpt-5.5");
    await provider.sendMessage([userMsg("hi")], {
      config: { model: "gpt-5.6-terra", promptCacheKey: "conv-1" },
    });

    expect(lastStreamParams?.model).toBe("gpt-5.6-terra");
    expect(lastStreamParams?.prompt_cache_options).toEqual({
      mode: "explicit",
    });
    expect(breakpointedItemIndexes()).toEqual([0]);
  });

  test("codex subscription endpoint gets no cache params", async () => {
    const provider = makeProvider("gpt-5.6-sol", true);
    await provider.sendMessage([userMsg("hi")], {
      config: { promptCacheKey: "conv-1" },
    });

    expect(lastStreamParams?.prompt_cache_options).toBeUndefined();
    expect(lastStreamParams?.prompt_cache_key).toBeUndefined();
    expect(JSON.stringify(lastStreamParams?.input)).not.toContain(
      "prompt_cache_breakpoint",
    );
  });

  test("never mutates the caller's messages", async () => {
    const provider = makeProvider("gpt-5.6-sol");
    const messages = [userMsg("t1"), assistantMsg("r1"), userMsg("t2")];
    await provider.sendMessage(messages, {
      config: { promptCacheKey: "conv-1" },
    });

    expect(JSON.stringify(messages)).not.toContain("prompt_cache_breakpoint");
  });

  test("catalog flags exactly the GPT-5.6 direct-openai rows", () => {
    const openai = PROVIDER_CATALOG.find((p) => p.id === "openai");
    const flagged = (openai?.models ?? [])
      .filter((m) => m.supportsPromptCacheBreakpoints)
      .map((m) => m.id)
      .sort();
    expect(flagged).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
  });
});
