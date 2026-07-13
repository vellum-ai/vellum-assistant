import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Anthropic } from "@anthropic-ai/sdk";

import type {
  ContentBlock,
  Message,
  ToolDefinition,
} from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock Anthropic SDK — must be before importing the provider
// ---------------------------------------------------------------------------

let lastStreamParams: Record<string, unknown> | null = null;
let _lastStreamOptions: Record<string, unknown> | null = null;
let lastConstructorArgs: Record<string, unknown> | null = null;

type ScriptedStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "blockStart"; blockType?: "text" }
  | { kind: "blockStop" };

// When set, the mock fires these scripted stream events in order instead of
// the default single "Hello" text event. Tests reset this in beforeEach.
let scriptedStream: ScriptedStreamEvent[] | null = null;

const fakeResponse = {
  content: [{ type: "text", text: "Hello" }],
  model: "claude-sonnet-4-6",
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 50,
    cache_read_input_tokens: 30,
  },
  stop_reason: "end_turn",
};

class FakeAPIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "APIError";
  }
}

mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    static APIError = FakeAPIError;
    constructor(args: Record<string, unknown>) {
      lastConstructorArgs = { ...args };
    }
    #streamImpl = (
      params: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      lastStreamParams = JSON.parse(JSON.stringify(params));
      _lastStreamOptions = options ?? null;
      const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
      return {
        on(event: string, cb: (...args: unknown[]) => void) {
          (handlers[event] ??= []).push(cb);
          return this;
        },
        async finalMessage() {
          if (scriptedStream) {
            for (const event of scriptedStream) {
              if (event.kind === "text") {
                for (const cb of handlers["text"] ?? []) {
                  cb(event.text);
                }
              } else if (event.kind === "blockStart") {
                for (const cb of handlers["streamEvent"] ?? []) {
                  cb({
                    type: "content_block_start",
                    content_block: { type: event.blockType ?? "text" },
                  });
                }
              } else if (event.kind === "blockStop") {
                for (const cb of handlers["streamEvent"] ?? []) {
                  cb({ type: "content_block_stop" });
                }
              }
            }
          } else {
            // Default: a single "Hello" text event (preserves existing tests).
            for (const cb of handlers["text"] ?? []) {
              cb("Hello");
            }
          }
          return fakeResponse;
        },
      };
    };
    messages = {
      stream: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => this.#streamImpl(params, options),
    };
    beta = {
      messages: {
        stream: (
          params: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => this.#streamImpl(params, options),
      },
    };
  },
}));

// Import after mocking
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../prompts/cache-boundary.js";
import { AnthropicProvider } from "../providers/anthropic/client.js";
import {
  isPlaceholderSentinelText,
  PLACEHOLDER_BLOCKS_OMITTED,
  PLACEHOLDER_EMPTY_TURN,
} from "../providers/placeholder-sentinels.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    content: [
      { type: "tool_result", tool_use_id: toolUseId, content, is_error: false },
    ],
  };
}

// A stable prefix text block carrying a 1h-TTL cache_control breakpoint, as a
// caller may stamp before the provider sees it. The internal ContentBlock type
// omits cache_control (only the provider transforms it onto the wire), so reach
// it via a cast.
function cachedPrefixBlock(text: string): ContentBlock {
  return {
    type: "text",
    text,
    cache_control: { type: "ephemeral", ttl: "1h" },
  } as unknown as ContentBlock;
}

const sampleTools: ToolDefinition[] = [
  {
    name: "file_read",
    description: "Read a file",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "file_write",
    description: "Write a file",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
  },
  {
    name: "bash",
    description: "Run shell commands",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
    },
  },
];

// ---------------------------------------------------------------------------
// Tests — Cache-Control Characterization
// ---------------------------------------------------------------------------

describe("AnthropicProvider — Cache-Control Characterization", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    lastStreamParams = null;
    _lastStreamOptions = null;
    lastConstructorArgs = null;
    scriptedStream = null;
    provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
  });

  // -----------------------------------------------------------------------
  // System prompt cache control
  // -----------------------------------------------------------------------
  test("system prompt has cache_control ephemeral with 1h TTL", async () => {
    await provider.sendMessage([userMsg("Hi")], {
      systemPrompt: "You are helpful.",
    });

    const system = lastStreamParams!.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("no system param when system prompt is omitted", async () => {
    await provider.sendMessage([userMsg("Hi")]);

    expect(lastStreamParams!.system).toBeUndefined();
  });

  test("sends disabled thinking config natively", async () => {
    await provider.sendMessage([userMsg("Hi")], {
      config: { thinking: { type: "disabled" } },
    });

    expect(lastStreamParams!.thinking).toEqual({ type: "disabled" });
  });

  test("drops unsigned thinking blocks from prior assistant messages", async () => {
    await provider.sendMessage([
      userMsg("Hi"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "non-native reasoning", signature: "" },
          { type: "text", text: "I can help." },
        ],
      },
      userMsg("Continue"),
    ]);

    const messages = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string; thinking?: string }>;
    }>;
    const assistant = messages.find((message) => message.role === "assistant");

    expect(assistant?.content).toEqual([{ type: "text", text: "I can help." }]);
  });

  test("renders the system prompt as a single 1h-cached block", async () => {
    const prompt = "You are a helpful assistant.";

    await provider.sendMessage([userMsg("Hi")], { systemPrompt: prompt });

    const system = lastStreamParams!.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(system).toHaveLength(1);
    expect(system[0].text).toBe(prompt);
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("applies the standard 4-breakpoint cache layout in a tool-use loop", async () => {
    // system(1) + tools(1) + turn-start(1) + tail(1) = 4, the Anthropic
    // per-request cap.  All four breakpoints should be present.
    const prompt = "You are a helpful assistant.";
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_1", "bash"),
      toolResultMsg("tu_1", "output"),
    ];
    await provider.sendMessage(messages, {
      tools: sampleTools,
      systemPrompt: prompt,
    });

    const system = lastStreamParams!.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    const tools = lastStreamParams!.tools as Array<{
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(tools[tools.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const turnStart = sent[0];
    expect(
      turnStart.content[turnStart.content.length - 1].cache_control,
    ).toEqual({ type: "ephemeral", ttl: "1h" });
    const lastMsg = sent[sent.length - 1];
    expect(lastMsg.content[lastMsg.content.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
  });

  test("splits a boundary-carrying system prompt into two cached blocks and drops the tool breakpoint", async () => {
    /**
     * Tests that the SYSTEM_PROMPT_CACHE_BOUNDARY marker yields two
     * independently cached system blocks, and that the explicit
     * last-tool breakpoint is suppressed (the first system breakpoint
     * already covers tools) so the total stays within Anthropic's
     * 4-breakpoint budget.
     */
    // GIVEN a system prompt carrying a cache boundary, plus tools and a
    // tool-use loop (so turn-start and tail breakpoints also apply)
    const prompt = `stable sections${SYSTEM_PROMPT_CACHE_BOUNDARY}volatile sections`;
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_1", "bash"),
      toolResultMsg("tu_1", "output"),
    ];

    // WHEN the message is sent
    await provider.sendMessage(messages, {
      tools: sampleTools,
      systemPrompt: prompt,
    });

    // THEN the system prompt is split into two blocks, each 1h-cached
    const system = lastStreamParams!.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(system).toHaveLength(2);
    expect(system[0].text).toBe("stable sections");
    expect(system[1].text).toBe("volatile sections");
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // AND no tool carries a breakpoint (system block 1 covers them)
    const tools = lastStreamParams!.tools as Array<{
      cache_control?: { type: string; ttl?: string };
    }>;
    for (const tool of tools) {
      expect(tool.cache_control).toBeUndefined();
    }

    // AND the turn-start and tail message breakpoints are unchanged,
    // keeping the total at the 4-breakpoint cap
    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const turnStart = sent[0];
    expect(
      turnStart.content[turnStart.content.length - 1].cache_control,
    ).toEqual({ type: "ephemeral", ttl: "1h" });
    const lastMsg = sent[sent.length - 1];
    expect(lastMsg.content[lastMsg.content.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
  });

  test("keeps the last-tool breakpoint when the system prompt has no boundary", async () => {
    /**
     * Tests that a boundary-free system prompt preserves the explicit
     * tool breakpoint (single system block leaves budget for it).
     */
    // GIVEN a system prompt without a cache boundary and tools
    // WHEN the message is sent
    await provider.sendMessage([userMsg("Hi")], {
      tools: sampleTools,
      systemPrompt: "You are helpful.",
    });

    // THEN the last tool keeps its breakpoint
    const tools = lastStreamParams!.tools as Array<{
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(tools[tools.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  // -----------------------------------------------------------------------
  // Tool cache control
  // -----------------------------------------------------------------------
  test("only last tool definition includes cache_control", async () => {
    await provider.sendMessage([userMsg("Hi")], { tools: sampleTools });

    const tools = lastStreamParams!.tools as Array<{
      name: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(tools).toHaveLength(3);

    // First two tools: no cache_control
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toBeUndefined();

    // Last tool: cache_control ephemeral
    expect(tools[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("single tool gets cache_control", async () => {
    await provider.sendMessage([userMsg("Hi")], { tools: [sampleTools[0]] });

    const tools = lastStreamParams!.tools as Array<{
      name: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("preserves a caller's 1h block cache_control and sends the extended-cache beta (non-Haiku)", async () => {
    // A caller that stamps a stable prefix block with a 1h TTL: the non-Haiku
    // path must forward it unchanged and send the beta header.
    await provider.sendMessage([
      {
        role: "user",
        content: [
          cachedPrefixBlock("stable pages block"),
          { type: "text", text: "volatile current message" },
        ],
      },
    ]);

    const messages = lastStreamParams!.messages as Array<{
      content: Array<{ cache_control?: { type: string; ttl?: string } }>;
    }>;
    expect(messages[0].content[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(lastStreamParams!.betas).toContain("extended-cache-ttl-2025-04-11");
  });

  test("strips ttl from a caller's block cache_control and omits the beta for Haiku", async () => {
    // Haiku doesn't support the extended-cache-ttl beta, so a caller-stamped
    // 1h ttl on a message block must be stripped before sending.
    const haiku = new AnthropicProvider(
      "sk-ant-test",
      "claude-haiku-4-5-20251001",
    );
    await haiku.sendMessage([
      {
        role: "user",
        content: [
          cachedPrefixBlock("stable pages block"),
          { type: "text", text: "volatile current message" },
        ],
      },
    ]);

    const messages = lastStreamParams!.messages as Array<{
      content: Array<{ cache_control?: { type: string; ttl?: string } }>;
    }>;
    expect(messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(messages[0].content[0].cache_control).not.toHaveProperty("ttl");
    expect(
      (lastStreamParams!.betas as string[] | undefined) ?? [],
    ).not.toContain("extended-cache-ttl-2025-04-11");
  });

  test("disableCache sends no cache_control anywhere and strips caller-stamped block markers", async () => {
    // A one-shot call site that opted out of prompt caching: no breakpoint
    // on system, tools, turn-start, or tail — and a caller-stamped block
    // marker is removed rather than forwarded.
    const messages: Message[] = [
      {
        role: "user",
        content: [
          cachedPrefixBlock("stable pages block"),
          { type: "text", text: "Do something" },
        ],
      },
      toolUseMsg("tu_1", "bash"),
      toolResultMsg("tu_1", "output"),
    ];
    await provider.sendMessage(messages, {
      tools: sampleTools,
      systemPrompt: "You are a helpful assistant.",
      config: { disableCache: true },
    });

    const system = lastStreamParams!.system as Array<{
      cache_control?: unknown;
    }>;
    expect(system[0].cache_control).toBeUndefined();

    const tools = lastStreamParams!.tools as Array<{
      cache_control?: unknown;
    }>;
    for (const tool of tools) {
      expect(tool.cache_control).toBeUndefined();
    }

    const sent = lastStreamParams!.messages as Array<{
      content: Array<{ cache_control?: unknown }>;
    }>;
    for (const message of sent) {
      for (const block of message.content) {
        expect(block.cache_control).toBeUndefined();
      }
    }
  });

  test("v3-shape call (system + tools + cached prefix block) stays within the 4-breakpoint cap", async () => {
    // Mirrors a v3 L2 selector call: a system prompt, a forced tool, and a user
    // message whose stable <pages> block carries a cache_control breakpoint
    // followed by the volatile current-message block. The preserved prefix
    // breakpoint plus the client's system/tools/turn-start anchors must total
    // exactly Anthropic's max of 4.
    await provider.sendMessage(
      [
        {
          role: "user",
          content: [
            cachedPrefixBlock("stable pages block"),
            { type: "text", text: "volatile current message" },
          ],
        },
      ],
      { systemPrompt: "Select relevant pages.", tools: [sampleTools[0]] },
    );

    let breakpoints = 0;
    const system = lastStreamParams!.system as
      | Array<{ cache_control?: unknown }>
      | undefined;
    for (const b of system ?? []) {
      if (b.cache_control) {
        breakpoints++;
      }
    }
    const tools = lastStreamParams!.tools as
      | Array<{ cache_control?: unknown }>
      | undefined;
    for (const t of tools ?? []) {
      if (t.cache_control) {
        breakpoints++;
      }
    }
    const messages = lastStreamParams!.messages as Array<{
      content: Array<{ cache_control?: { type: string; ttl?: string } }>;
    }>;
    for (const m of messages) {
      for (const b of m.content) {
        if (b.cache_control) {
          breakpoints++;
        }
      }
    }

    expect(breakpoints).toBe(4);
    // The stable pages block specifically must hold the preserved breakpoint.
    expect(messages[0].content[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  test("no tools param when tools are omitted", async () => {
    await provider.sendMessage([userMsg("Hi")]);

    expect(lastStreamParams!.tools).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Advancing tail — 5m cache on last block after turn-starting message
  // -----------------------------------------------------------------------
  test("no advancing tail cache when turn-starting user message is last", async () => {
    await provider.sendMessage([userMsg("Hello")]);

    // No top-level cache_control — would conflict with the 1h block breakpoint
    expect(
      (lastStreamParams as Record<string, unknown>).cache_control,
    ).toBeUndefined();
  });

  test("advancing tail: 5m cache on last block when tool results follow turn-starting message", async () => {
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_1", "bash"),
      toolResultMsg("tu_1", "output"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;

    // Turn-starting user message (first) keeps 1h
    const turnStart = sent[0];
    const turnStartLast = turnStart.content[turnStart.content.length - 1];
    expect(turnStartLast.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    // Last message (tool_result) gets 5m advancing tail
    const lastMessage = sent[sent.length - 1];
    const lastBlock = lastMessage.content[lastMessage.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  test("turn-starting user message gets 1h cache on last block", async () => {
    const messages: Message[] = [
      userMsg("Turn 1"),
      assistantMsg("Response 1"),
      userMsg("Turn 2"),
      assistantMsg("Response 2"),
      userMsg("Turn 3"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;

    const userMessages = sent.filter((m) => m.role === "user");
    // Oldest user message (Turn 1) has no cache_control
    for (const block of userMessages[0].content) {
      expect(block.cache_control).toBeUndefined();
    }
    // Previous-turn anchor (Turn 2) gets 1h cache on its last block to
    // preserve the cached prefix across turn transitions
    const prevTurn = userMessages[userMessages.length - 2];
    const prevTurnLast = prevTurn.content[prevTurn.content.length - 1];
    expect(prevTurnLast.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    // Current-turn anchor (Turn 3) gets 1h cache on its last block
    const lastUser = userMessages[userMessages.length - 1];
    const lastBlock = lastUser.content[lastUser.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("disableTurnStartCache suppresses the 1h breakpoint on the turn-starting user message", async () => {
    // One-shot callers (e.g. the memory router) send a single user message
    // per call with content that changes every time. Caching the turn-start
    // block would create unused entries — `disableTurnStartCache: true`
    // opts out.
    await provider.sendMessage([userMsg("Pick relevant pages")], {
      config: { disableTurnStartCache: true },
    });

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const lastBlock = sent[0].content[sent[0].content.length - 1];
    expect(lastBlock.cache_control).toBeUndefined();
  });

  test("previous-turn anchor is NOT applied during a tool-use loop", async () => {
    // When the request is mid tool-use (last msg is a tool_result), the
    // turn-start anchor already covers the long prefix, so we must not
    // place a second anchor on the prior turn — that would push us over
    // the 4-breakpoint budget without adding cache value.
    const messages: Message[] = [
      userMsg("Turn 1"),
      assistantMsg("Response 1"),
      userMsg("Turn 2"),
      toolUseMsg("tu_1", "bash"),
      toolResultMsg("tu_1", "output"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    // Turn 1 user message must have no cache_control (would be the
    // prev-turn-anchor if we applied it, which we shouldn't here)
    const turn1 = sent[0];
    for (const block of turn1.content) {
      expect(block.cache_control).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------------
  // mutableLatestUserMessage — volatile trailing user message cache anchor
  // -----------------------------------------------------------------------
  test("mutableLatestUserMessage: first-of-turn moves the 1h anchor off the volatile latest message and bridges it with a 5m tail", async () => {
    // The latest user message carries per-turn-volatile content (e.g. an
    // injected memory block). The 1h anchor must move off it onto the most
    // recent stable user message so the cached prefix stays reusable across
    // turns; the volatile message still gets a cheap 5m tail breakpoint so the
    // next request in the same turn has an exact, reachable boundary.
    const messages: Message[] = [
      userMsg("Turn 1"),
      assistantMsg("Response 1"),
      userMsg("Turn 2 (volatile)"),
    ];
    await provider.sendMessage(messages, {
      config: { mutableLatestUserMessage: true },
    });

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const userMessages = sent.filter((m) => m.role === "user");

    // Latest (turn-start) user message gets the cheap 5m tail bridge, never the
    // 1h anchor — it's volatile.
    const latest = userMessages[userMessages.length - 1];
    const latestLast = latest.content[latest.content.length - 1];
    expect(latestLast.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });

    // Previous stable user message (Turn 1) becomes the primary 1h anchor.
    const prev = userMessages[userMessages.length - 2];
    const prevLast = prev.content[prev.content.length - 1];
    expect(prevLast.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("mutableLatestUserMessage absent: breakpoint placement is byte-identical to default behavior (v2 regression guard)", async () => {
    const messages: Message[] = [
      userMsg("Turn 1"),
      assistantMsg("Response 1"),
      userMsg("Turn 2"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const userMessages = sent.filter((m) => m.role === "user");

    // Current-turn (latest) anchor keeps 1h.
    const latest = userMessages[userMessages.length - 1];
    const latestLast = latest.content[latest.content.length - 1];
    expect(latestLast.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Previous-turn anchor keeps 1h.
    const prev = userMessages[userMessages.length - 2];
    const prevLast = prev.content[prev.content.length - 1];
    expect(prevLast.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("mutableLatestUserMessage: during a tool-use loop placement is unchanged (block is fixed within the turn)", async () => {
    // Turn-start is not the last message (tool_result follows), so the
    // turn-start block is fixed for the rest of the turn — the flag must not
    // move the anchor.
    const messages: Message[] = [
      userMsg("Turn 1"),
      assistantMsg("Response 1"),
      userMsg("Turn 2"),
      toolUseMsg("tu_1", "bash"),
      toolResultMsg("tu_1", "output"),
    ];
    await provider.sendMessage(messages, {
      config: { mutableLatestUserMessage: true },
    });

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;

    // Turn-start (Turn 2, index 2) still gets the 1h anchor — within a tool-use
    // loop the block is fixed, so the volatile-latest flag must not move it.
    const turn2 = sent[2];
    const turn2Last = turn2.content[turn2.content.length - 1];
    expect(turn2Last.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("mutableLatestUserMessage: first turn with no previous user message does not throw and applies no long-TTL anchor", async () => {
    await provider.sendMessage([userMsg("First ever turn (volatile)")], {
      config: { mutableLatestUserMessage: true },
    });

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    // Only user message is volatile and there is no prior stable one, so no
    // 1h anchor and no 5m tail bridge land on any user message — there is no
    // previous-turn anchor to bridge to. Graceful, no throw.
    const lastBlock = sent[0].content[sent[0].content.length - 1];
    expect(lastBlock.cache_control).toBeUndefined();
  });

  test("mutableLatestUserMessage: first-of-turn after a long autonomous tail bridges the volatile latest message so the next call stays within the lookback window", async () => {
    // Reproduces the memory-retrospective / heartbeat case: a long run of
    // autonomous assistant + tool turns sits between the previous user message
    // and the volatile latest one. The 1h anchor moves back onto the previous
    // user message (now >20 content blocks away); without a breakpoint on the
    // latest message the next request's anchor would land beyond Anthropic's
    // ~20-block lookback and re-create the whole prefix. The 5m tail bridge
    // gives the next call an exact, reachable boundary.
    const tail: Message[] = [];
    for (let i = 0; i < 8; i++) {
      tail.push(
        assistantMsg(`heartbeat ${i}`),
        toolUseMsg(`hb_${i}`, "bash"),
        toolResultMsg(`hb_${i}`, "wake"),
      );
    }
    // End the tail on an assistant message so the latest user message is not
    // merged with a preceding tool_result (both user role).
    tail.push(assistantMsg("still here"));
    const messages: Message[] = [
      userMsg("Turn 1"),
      ...tail,
      userMsg("Turn 2 (volatile)"),
    ];
    await provider.sendMessage(messages, {
      config: { mutableLatestUserMessage: true },
    });

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text?: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const findUser = (text: string) =>
      sent.find(
        (m) => m.role === "user" && m.content.some((b) => b.text === text),
      )!;

    // The volatile latest message gets the 5m tail bridge.
    const turn2 = findUser("Turn 2 (volatile)");
    const turn2Last = turn2.content[turn2.content.length - 1];
    expect(turn2Last.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });

    // The previous stable user message — across the whole autonomous tail —
    // is the 1h anchor.
    const turn1 = findUser("Turn 1");
    const turn1Last = turn1.content[turn1.content.length - 1];
    expect(turn1Last.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("mutableLatestUserMessage absent: the same long autonomous tail gets no extra tail bridge (placement unchanged)", async () => {
    // Regression guard: the tail bridge is gated on the volatile-latest flag,
    // not on tail length. With the flag off, the latest message keeps the
    // ordinary 1h turn-start anchor and no 5m bridge is added.
    const tail: Message[] = [];
    for (let i = 0; i < 8; i++) {
      tail.push(
        assistantMsg(`heartbeat ${i}`),
        toolUseMsg(`hb_${i}`, "bash"),
        toolResultMsg(`hb_${i}`, "wake"),
      );
    }
    // End the tail on an assistant message so the latest user message is not
    // merged with a preceding tool_result (both user role).
    tail.push(assistantMsg("still here"));
    const messages: Message[] = [userMsg("Turn 1"), ...tail, userMsg("Turn 2")];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text?: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const findUser = (text: string) =>
      sent.find(
        (m) => m.role === "user" && m.content.some((b) => b.text === text),
      )!;

    // Latest message keeps the 1h turn-start anchor — no 5m bridge.
    const turn2 = findUser("Turn 2");
    const turn2Last = turn2.content[turn2.content.length - 1];
    expect(turn2Last.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Previous-turn anchor keeps 1h.
    const turn1 = findUser("Turn 1");
    const turn1Last = turn1.content[turn1.content.length - 1];
    expect(turn1Last.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("mutableLatestUserMessage + disableTurnStartCache: the first-of-turn tail bridge is suppressed on the volatile latest block", async () => {
    // The volatile-latest tail bridge lands on the turn-start block, so it must
    // honor disableTurnStartCache (the explicit opt-out from paid cache writes
    // on volatile turn-start content) just like the long-TTL anchor does. The
    // previous-turn anchor is unaffected — it targets a stable prior block.
    const messages: Message[] = [
      userMsg("Turn 1"),
      assistantMsg("Response 1"),
      userMsg("Turn 2 (volatile)"),
    ];
    await provider.sendMessage(messages, {
      config: { mutableLatestUserMessage: true, disableTurnStartCache: true },
    });

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const userMessages = sent.filter((m) => m.role === "user");

    // Latest (turn-start) user message gets NO breakpoint — disableTurnStartCache
    // suppresses the 5m bridge.
    const latest = userMessages[userMessages.length - 1];
    for (const block of latest.content) {
      expect(block.cache_control).toBeUndefined();
    }

    // Previous stable user message (Turn 1) still gets the 1h anchor.
    const prev = userMessages[userMessages.length - 2];
    const prevLast = prev.content[prev.content.length - 1];
    expect(prevLast.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("mutableLatestUserMessage is not forwarded to the Anthropic API", async () => {
    await provider.sendMessage([userMsg("Hi")], {
      config: { mutableLatestUserMessage: true },
    });
    expect(
      (lastStreamParams as Record<string, unknown>).mutableLatestUserMessage,
    ).toBeUndefined();
  });

  test("promptCacheKey is not forwarded to the Anthropic API", async () => {
    // Reaches this client on OpenRouter's anthropic/* delegation path;
    // Anthropic rejects unknown fields with "Extra inputs are not permitted".
    await provider.sendMessage([userMsg("Hi")], {
      config: { promptCacheKey: "conv-1" },
    });
    expect(
      (lastStreamParams as Record<string, unknown>).promptCacheKey,
    ).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Negative: assistant messages never get cache_control
  // -----------------------------------------------------------------------
  test("assistant messages do not get cache_control", async () => {
    const messages: Message[] = [
      userMsg("Hi"),
      assistantMsg("Hello!"),
      userMsg("How are you?"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const assistantMsgs = sent.filter((m) => m.role === "assistant");
    for (const a of assistantMsgs) {
      if (Array.isArray(a.content)) {
        for (const block of a.content) {
          expect(block.cache_control).toBeUndefined();
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // Multi-block user message: cache lands on LAST block
  // -----------------------------------------------------------------------
  test("multi-block single user message gets cache on last block", async () => {
    const multiBlockUser: Message = {
      role: "user",
      content: [
        { type: "text", text: "First block" },
        { type: "text", text: "Second block" },
      ],
    };
    await provider.sendMessage([multiBlockUser]);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const user = sent[0];
    expect(user.content[0].cache_control).toBeUndefined();
    expect(user.content[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  // -----------------------------------------------------------------------
  // Usage: cache tokens are aggregated into inputTokens
  // -----------------------------------------------------------------------
  test("usage aggregates cache tokens into inputTokens", async () => {
    const result = await provider.sendMessage([userMsg("Hi")]);

    expect(result.usage.inputTokens).toBe(100 + 50 + 30); // input + creation + read
    expect(result.usage.cacheCreationInputTokens).toBe(50);
    expect(result.usage.cacheReadInputTokens).toBe(30);
  });

  // -----------------------------------------------------------------------
  // Cache compatibility with workspace context injection
  // -----------------------------------------------------------------------
  test("workspace-prepended single user message gets cache on last block", async () => {
    // Simulates what applyRuntimeInjections does: prepend workspace block, keep user text as trailing
    const workspaceInjectedUser: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: "<workspace>\nRoot: /sandbox\nDirectories: src, tests\n</workspace>",
        },
        { type: "text", text: "What files are in src?" },
      ],
    };
    await provider.sendMessage([workspaceInjectedUser]);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const user = sent[0];
    expect(user.content).toHaveLength(2);
    // Workspace block (first): no cache_control
    expect(user.content[0].cache_control).toBeUndefined();
    // User text (last): cache_control with 1h TTL
    expect(user.content[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  test("workspace + multi-block single user message: cache on last block only", async () => {
    // Simulates workspace prepended + extra context block appended
    const injectedUser: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: "<workspace>\nRoot: /sandbox\nDirectories: src, tests\n</workspace>",
        },
        { type: "text", text: "Help me debug this" },
        {
          type: "text",
          text: "<dynamic_profile>\nUser prefers TypeScript.\n</dynamic_profile>",
        },
      ],
    };
    await provider.sendMessage([injectedUser]);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const user = sent[0];
    expect(user.content).toHaveLength(3);
    // Only last block gets cache_control
    expect(user.content[0].cache_control).toBeUndefined();
    expect(user.content[1].cache_control).toBeUndefined();
    expect(user.content[2].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  // -----------------------------------------------------------------------
  // ensureToolPairing — tool_use / tool_result pairing repair
  // -----------------------------------------------------------------------

  test("tool_use with missing tool_result gets synthetic result injected", async () => {
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_1", "file_read"),
      userMsg("Thanks"), // user text but no tool_result for tu_1
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        is_error?: boolean;
      }>;
    }>;

    // The second user message (after assistant) should now contain a synthetic tool_result
    const userAfterAssistant = sent[2];
    expect(userAfterAssistant.role).toBe("user");
    // Anthropic expects tool_result blocks to start the immediate next user message.
    expect(userAfterAssistant.content[0].type).toBe("tool_result");
    const toolResults = userAfterAssistant.content.filter(
      (b) => b.type === "tool_result",
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe("tu_1");
    expect(toolResults[0].is_error).toBe(true);
  });

  test("tool_use at end of messages gets synthetic user message appended", async () => {
    const messages: Message[] = [
      userMsg("Read file"),
      toolUseMsg("tu_end", "file_read"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    // A synthetic user message should have been appended
    expect(sent).toHaveLength(3);
    expect(sent[2].role).toBe("user");
    const toolResults = sent[2].content.filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe("tu_end");
  });

  test("tool_use with matching tool_result passes through unchanged", async () => {
    const messages: Message[] = [
      userMsg("Read file"),
      toolUseMsg("tu_ok", "file_read"),
      toolResultMsg("tu_ok", "file contents"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    // No synthetic messages or blocks added
    expect(sent).toHaveLength(3);
    const toolResults = sent[2].content.filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe("tu_ok");
  });

  test("reconstructs collapsed assistant/tool_result/user timeline before sending", async () => {
    const messages: Message[] = [
      userMsg("Read files"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Working on it." },
          { type: "tool_use", id: "tu_a", name: "file_read", input: {} },
          { type: "tool_use", id: "tu_b", name: "bash", input: {} },
          { type: "text", text: "One moment." },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<workspace>\nRoot: /sandbox\n</workspace>",
          },
          {
            type: "tool_result",
            tool_use_id: "tu_b",
            content: "result B",
            is_error: false,
          },
          { type: "text", text: "continue please" },
          {
            type: "tool_result",
            tool_use_id: "tu_a",
            content: "result A",
            is_error: false,
          },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string; text?: string }>;
    }>;

    // Input had 3 messages, but the collapsed history shape should be expanded:
    // user, assistant(tool_use...), user(tool_results), assistant(carryover text), user(remaining text)
    expect(sent).toHaveLength(5);

    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content.map((b) => b.type)).toEqual([
      "text",
      "tool_use",
      "tool_use",
    ]);

    expect(sent[2].role).toBe("user");
    expect(sent[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_a",
    });
    expect(sent[2].content[1]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_b",
    });
    expect(sent[2].content).toHaveLength(2);

    expect(sent[3].role).toBe("assistant");
    expect(sent[3].content.map((b) => b.type)).toEqual(["text"]);

    expect(sent[4].role).toBe("user");
    expect(sent[4].content.map((b) => b.type)).toEqual(["text", "text"]);
  });

  test("multiple tool_use with partial results gets missing ones filled", async () => {
    const messages: Message[] = [
      userMsg("Do things"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_a", name: "file_read", input: {} },
          { type: "tool_use", id: "tu_b", name: "file_write", input: {} },
          { type: "tool_use", id: "tu_c", name: "bash", input: {} },
        ],
      },
      // Only tu_a has a result
      toolResultMsg("tu_a", "result A"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        is_error?: boolean;
      }>;
    }>;

    const userAfterAssistant = sent[2];
    const toolResults = userAfterAssistant.content.filter(
      (b) => b.type === "tool_result",
    );
    expect(toolResults).toHaveLength(3);
    expect(userAfterAssistant.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_a",
    });
    expect(userAfterAssistant.content[1]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_b",
    });
    expect(userAfterAssistant.content[2]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_c",
    });

    // tu_a: original result
    expect(
      toolResults.find((r) => r.tool_use_id === "tu_a")!.is_error,
    ).toBeFalsy();
    // tu_b and tu_c: synthetic
    expect(toolResults.find((r) => r.tool_use_id === "tu_b")!.is_error).toBe(
      true,
    );
    expect(toolResults.find((r) => r.tool_use_id === "tu_c")!.is_error).toBe(
      true,
    );
  });

  test("consecutive assistant messages with tool_use each get synthetic results", async () => {
    const messages: Message[] = [
      userMsg("Start"),
      toolUseMsg("tu_1", "file_read"),
      // missing tool_result for tu_1, then another assistant
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_2", name: "bash", input: {} }],
      },
      userMsg("Done"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    // Should be: user, assistant(tu_1), synthetic_user(tu_1), assistant(tu_2), user_with_synthetic(tu_2)
    expect(sent).toHaveLength(5);
    expect(sent[0].role).toBe("user");
    expect(sent[1].role).toBe("assistant");
    expect(sent[2].role).toBe("user");
    expect(
      sent[2].content.some(
        (b) => b.type === "tool_result" && b.tool_use_id === "tu_1",
      ),
    ).toBe(true);
    expect(sent[3].role).toBe("assistant");
    expect(sent[4].role).toBe("user");
    expect(
      sent[4].content.some(
        (b) => b.type === "tool_result" && b.tool_use_id === "tu_2",
      ),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // ensureToolPairing — server_tool_use / web_search_tool_result pairing
  // -----------------------------------------------------------------------

  test("orphaned server_tool_use gets synthetic web_search_tool_result injected", async () => {
    // When stream is interrupted, server_tool_use may be stored without its
    // paired web_search_tool_result. repairOrphanedServerToolBlocks should inject
    // a synthetic error web_search_tool_result after the orphan so the model
    // knows the search failed (rather than silently returning zero results).
    const messages: Message[] = [
      userMsg("Search for something"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_abc123",
            name: "web_search",
            input: { query: "test" },
          },
        ],
      },
      userMsg("Thanks"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        content?: unknown;
      }>;
    }>;

    // server_tool_use stays in the assistant message with synthetic result appended
    expect(sent).toHaveLength(3);
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content[0].type).toBe("server_tool_use");
    expect(sent[1].content[1].type).toBe("web_search_tool_result");
    expect(sent[1].content[1].tool_use_id).toBe("srvtoolu_abc123");
    expect(sent[1].content[1].content).toEqual({
      type: "web_search_tool_result_error",
      error_code: "unavailable",
    });
    expect(sent[2].role).toBe("user");
    expect(sent[2].content[0].type).toBe("text");
  });

  test("orphaned server_tool_use at end of messages gets synthetic result (no synthetic user append)", async () => {
    // Orphaned server_tool_use at the end should get a synthetic
    // web_search_tool_result but no synthetic user message.
    const messages: Message[] = [
      userMsg("Search something"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_end",
            name: "web_search",
            input: { query: "test" },
          },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    // Original 2 messages, with synthetic result injected in assistant message
    expect(sent).toHaveLength(2);
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content[0].type).toBe("server_tool_use");
    expect(sent[1].content[1].type).toBe("web_search_tool_result");
    expect(sent[1].content[1].tool_use_id).toBe("srvtoolu_end");
  });

  test("server_tool_use with matching web_search_tool_result passes through unchanged", async () => {
    const messages: Message[] = [
      userMsg("Search something"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_ok",
            name: "web_search",
            input: { query: "test" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_ok",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "Example",
                encrypted_content: "enc_abc",
              },
            ],
          },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    // No synthetic messages or blocks added
    expect(sent).toHaveLength(3);
    const resultBlocks = sent[2].content.filter(
      (b) => b.type === "web_search_tool_result",
    );
    expect(resultBlocks).toHaveLength(1);
    expect(resultBlocks[0].tool_use_id).toBe("srvtoolu_ok");
  });

  test("server_tool_use + web_search_tool_result + tool_use in same assistant message stays intact", async () => {
    // This is the core bug scenario: Anthropic returns server_tool_use,
    // web_search_tool_result, text, and tool_use all in one assistant message.
    // The server pair must stay together in the assistant message.
    const messages: Message[] = [
      userMsg("Search and fetch"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_search",
            name: "web_search",
            input: { query: "test" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_search",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "Example",
                encrypted_content: "enc_123",
              },
            ],
          },
          { type: "text", text: "Based on the search results..." },
          {
            type: "tool_use",
            id: "tu_fetch",
            name: "fetch_url",
            input: { url: "https://example.com" },
          },
        ],
      },
      toolResultMsg("tu_fetch", "page content here"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        id?: string;
        tool_use_id?: string;
      }>;
    }>;

    // The server_tool_use pair (server_tool_use + web_search_tool_result) should
    // be in the leading portion of the assistant message, before tool_use.
    // splitAssistantForToolPairing: leading=[server_tool_use, web_search_tool_result, text],
    // toolUseBlocks=[tool_use], carryover=[]
    const assistantMsg = sent[1];
    expect(assistantMsg.role).toBe("assistant");
    const blockTypes = assistantMsg.content.map((b) => b.type);
    expect(blockTypes).toContain("server_tool_use");
    expect(blockTypes).toContain("web_search_tool_result");
    expect(blockTypes).toContain("tool_use");

    // The tool_result for the client-side tool_use should be in the user message
    const userMsg2 = sent[2];
    expect(userMsg2.role).toBe("user");
    expect(
      userMsg2.content.some(
        (b) => b.type === "tool_result" && b.tool_use_id === "tu_fetch",
      ),
    ).toBe(true);

    // No synthetic web_search_tool_result injected anywhere
    const allBlocks = sent.flatMap((m) => m.content);
    const webSearchResults = allBlocks.filter(
      (b) => b.type === "web_search_tool_result",
    );
    expect(webSearchResults).toHaveLength(1); // only the original one
    expect(webSearchResults[0].tool_use_id).toBe("srvtoolu_search");
  });

  test("mixed tool_use and server_tool_use — only client-side tool_use gets pairing, server tools pass through", async () => {
    const messages: Message[] = [
      userMsg("Do things"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_a", name: "file_read", input: {} },
          {
            type: "server_tool_use",
            id: "srvtoolu_b",
            name: "web_search",
            input: { query: "test" },
          },
        ],
      },
      // Only tu_a has a result — server_tool_use doesn't need one in the user message
      toolResultMsg("tu_a", "result A"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        id?: string;
      }>;
    }>;

    // Assistant message should have tool_use in paired portion, server_tool_use in carryover
    // ensureToolPairing splits: paired = [tool_use(tu_a)], carryover = [server_tool_use(srvtoolu_b)]
    // Result: assistant(tool_use) → user(tool_result) → assistant(server_tool_use) → user(synthetic_continuation)
    const assistantMsg = sent[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content[0].type).toBe("tool_use");

    const userAfterAssistant = sent[2];
    expect(userAfterAssistant.role).toBe("user");
    // Only tool_result for tu_a — no synthetic web_search_tool_result
    expect(userAfterAssistant.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_a",
    });

    // server_tool_use preserved in a carryover assistant message with synthetic result
    const carryoverAssistant = sent[3];
    expect(carryoverAssistant.role).toBe("assistant");
    expect(carryoverAssistant.content[0].type).toBe("server_tool_use");
    expect(carryoverAssistant.content[1].type).toBe("web_search_tool_result");
    expect(carryoverAssistant.content[1].tool_use_id).toBe("srvtoolu_b");
  });

  test("orphaned server_tool_use from interrupted stream gets repaired in multi-turn conversation", async () => {
    // Reproduces the real bug: web_search stream interrupted, server_tool_use
    // stored without web_search_tool_result, next user message triggers replay
    // which would cause a 400 error without the repair.
    const messages: Message[] = [
      userMsg("fetch this page and search the web"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll do both." },
          {
            type: "tool_use",
            id: "tu_fetch",
            name: "web_fetch",
            input: { url: "https://example.com" },
          },
          {
            type: "server_tool_use",
            id: "srvtoolu_interrupted",
            name: "web_search",
            input: { query: "test" },
          },
          // NOTE: no web_search_tool_result — stream was interrupted
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_fetch",
            content: "page content here",
            is_error: false,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "The fetch worked but search failed." },
        ],
      },
      userMsg("try again"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        id?: string;
        tool_use_id?: string;
        content?: unknown;
      }>;
    }>;

    // The orphaned server_tool_use should have a synthetic web_search_tool_result
    // injected in the assistant message, preventing the 400 error.
    const allBlocks = sent.flatMap((m) => m.content);
    const syntheticResults = allBlocks.filter(
      (b) =>
        b.type === "web_search_tool_result" &&
        b.tool_use_id === "srvtoolu_interrupted",
    );
    expect(syntheticResults).toHaveLength(1);
    expect(syntheticResults[0].content).toEqual({
      type: "web_search_tool_result_error",
      error_code: "unavailable",
    });
  });

  test("paired server_tool_use is not modified by repair", async () => {
    // When server_tool_use has its matching web_search_tool_result,
    // repairOrphanedServerToolBlocks should not inject anything.
    const messages: Message[] = [
      userMsg("search"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_paired",
            name: "web_search",
            input: { query: "test" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_paired",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "Example",
                encrypted_content: "enc",
              },
            ],
          },
          { type: "text", text: "Found results." },
        ],
      },
      userMsg("thanks"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    // Only 1 web_search_tool_result — the original, no synthetic one added
    const allBlocks = sent.flatMap((m) => m.content);
    const wsResults = allBlocks.filter(
      (b) => b.type === "web_search_tool_result",
    );
    expect(wsResults).toHaveLength(1);
    expect(wsResults[0].tool_use_id).toBe("srvtoolu_paired");
  });

  test("orphaned web_search_tool_result with no preceding server_tool_use gets downgraded to text", async () => {
    // The inverse of the orphan server_tool_use case. A
    // web_search_tool_result whose tool_use_id has no matching server_tool_use
    // in the same assistant message would trip Anthropic's
    // "messages.N.content.M: unexpected tool_use_id" error. Downgrading the
    // orphan to a text block preserves the titles/URLs for the model and
    // keeps the request valid.
    const messages: Message[] = [
      userMsg("Tell me more"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_orphaned",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "Example",
                encrypted_content: "enc_abc",
              },
            ],
          },
        ],
      },
      userMsg("Thanks"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string; tool_use_id?: string }>;
    }>;

    // No web_search_tool_result block survives anywhere in the dispatched
    // request — the orphan must be downgraded so Anthropic doesn't 400.
    const allBlocks = sent.flatMap((m) => m.content);
    expect(allBlocks.every((b) => b.type !== "web_search_tool_result")).toBe(
      true,
    );

    // The downgrade text references the orphan id and the result's URL so
    // the model retains context.
    const assistantMsg = sent[1];
    expect(assistantMsg.role).toBe("assistant");
    const downgraded = assistantMsg.content.find(
      (b) => b.type === "text" && b.text?.includes("srvtoolu_orphaned"),
    );
    expect(downgraded).toBeDefined();
    expect(downgraded!.text).toContain("https://example.com");
  });

  test("orphaned web_search_tool_result with no content array still downgrades cleanly", async () => {
    const messages: Message[] = [
      userMsg("status?"),
      {
        role: "assistant",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_empty",
            content: {
              type: "web_search_tool_result_error",
              error_code: "unavailable",
            },
          },
        ],
      },
      userMsg("ok"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    const allBlocks = sent.flatMap((m) => m.content);
    expect(allBlocks.every((b) => b.type !== "web_search_tool_result")).toBe(
      true,
    );
    const downgraded = sent[1].content.find(
      (b) => b.type === "text" && b.text?.includes("srvtoolu_empty"),
    );
    expect(downgraded).toBeDefined();
    expect(downgraded!.text).toContain("results unavailable");
  });

  test("assistant message with only unknown blocks gets placeholder text", async () => {
    const messages: Message[] = [
      userMsg("Start"),
      // Assistant message with only ui_surface (unknown type) — will be filtered
      {
        role: "assistant",
        content: [
          { type: "ui_surface" as "text", text: "this will be filtered" },
        ],
      },
      userMsg("Continue"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    // Should preserve alternation: user, assistant (with placeholder), user
    expect(sent).toHaveLength(3);
    expect(sent[0].role).toBe("user");
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content).toHaveLength(1);
    expect(sent[1].content[0].type).toBe("text");
    expect(sent[1].content[0].text).toBe(PLACEHOLDER_BLOCKS_OMITTED);
    expect(sent[2].role).toBe("user");
  });

  test("assistant skill_card message: ui_surface is stripped and the _surfaceFallback text reaches the wire", async () => {
    // Contract-shaped block pair persisted by the memory retrospective's
    // skill-card insertion (memory-retrospective-skill-card.ts): the
    // ui_surface card plus a `_surfaceFallback` text sibling. The provider
    // must drop the ui_surface block and send the fallback text as the
    // assistant turn's real content — no placeholder needed.
    const skillCardBlock = {
      type: "ui_surface",
      surfaceId: "skill-card-run-conv-1",
      surfaceType: "skill_card",
      title: "New skill learned",
      display: "inline",
      data: {
        skills: [
          {
            skillId: "skill-1",
            name: "Example skill",
            description: "Does a thing",
            emoji: null,
          },
        ],
      },
    } as unknown as ContentBlock;
    const fallbackBlock = {
      type: "text",
      text: "New skill learned: Example skill",
      _surfaceFallback: true,
    } as unknown as ContentBlock;
    const messages: Message[] = [
      userMsg("Start"),
      { role: "assistant", content: [skillCardBlock, fallbackBlock] },
      userMsg("Continue"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    // No ui_surface block (or any of its payload) reaches the wire; the
    // assistant turn carries the fallback text (stripped of the internal
    // `_surfaceFallback` marker), so alternation holds without a placeholder.
    expect(sent).toHaveLength(3);
    expect(
      sent.flatMap((m) => m.content).every((b) => b.type !== "ui_surface"),
    ).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("skill_card");
    expect(JSON.stringify(sent)).not.toContain("_surfaceFallback");
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content).toEqual([
      { type: "text", text: "New skill learned: Example skill" },
    ]);
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i].role).not.toBe(sent[i - 1].role);
    }
  });

  test("assistant message with mix of known and unknown blocks keeps known blocks", async () => {
    const messages: Message[] = [
      userMsg("Start"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Valid text" },
          { type: "ui_surface" as "text", text: "this will be filtered" },
          { type: "text", text: "More valid text" },
        ],
      },
      userMsg("Continue"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(sent).toHaveLength(3);
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content).toHaveLength(2);
    expect(sent[1].content[0].text).toBe("Valid text");
    expect(sent[1].content[1].text).toBe("More valid text");
  });

  test("assistant message with only whitespace text gets placeholder to preserve alternation", async () => {
    const messages: Message[] = [
      userMsg("Start"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "   " },
          { type: "text", text: "\n\t" },
        ],
      },
      userMsg("Continue"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    // Whitespace-only assistant messages between user messages must be preserved
    // with a placeholder to maintain Anthropic's strict role alternation
    expect(sent).toHaveLength(3);
    expect(sent[0].role).toBe("user");
    expect(sent[0].content[0].text).toBe("Start");
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content).toHaveLength(1);
    expect(sent[1].content[0].type).toBe("text");
    expect(sent[1].content[0].text).toBe(PLACEHOLDER_EMPTY_TURN);
    expect(sent[2].role).toBe("user");
    expect(sent[2].content[0].text).toBe("Continue");
  });

  test("unknown-blocks-only assistant followed by empty user does not produce consecutive same-role messages", async () => {
    // Same edge case as the empty-assistant test below, but triggered by an
    // assistant turn whose blocks are all unknown (e.g. ui_surface). The turn
    // becomes a [internal blocks omitted] placeholder which must also be
    // removed when adjacent to a real assistant message.
    const messages: Message[] = [
      userMsg("Start"),
      {
        role: "assistant",
        content: [{ type: "ui_surface" as "text", text: "invisible" }], // unknown → placeholder
      },
      {
        role: "user",
        content: [{ type: "text", text: "  \n  " }], // whitespace-only → empty after filtering
      },
      assistantMsg("Real response"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    // Verify strict role alternation: no two adjacent messages share the same role
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i].role).not.toBe(sent[i - 1].role);
    }
  });

  test("empty assistant followed by empty user does not produce consecutive same-role messages", async () => {
    // Edge case: an empty assistant turn gets a placeholder injected, but if
    // the following user turn also filters to empty (e.g. whitespace-only),
    // the user turn is dropped and the placeholder ends up adjacent to the
    // next real assistant turn — producing consecutive assistant roles.
    const messages: Message[] = [
      userMsg("Start"),
      {
        role: "assistant",
        content: [{ type: "text", text: "   " }], // whitespace-only → empty after filtering
      },
      {
        role: "user",
        content: [{ type: "text", text: "  \n  " }], // whitespace-only → empty after filtering
      },
      assistantMsg("Real response"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    // Verify strict role alternation: no two adjacent messages share the same role
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i].role).not.toBe(sent[i - 1].role);
    }
  });

  test("consecutive real assistant messages are merged into one", async () => {
    // When two non-placeholder assistant messages appear consecutively
    // (e.g. history reconstruction artifacts), the provider must merge
    // their content blocks to satisfy Anthropic's strict role alternation.
    const messages: Message[] = [
      userMsg("Start"),
      assistantMsg("First response"),
      {
        role: "assistant",
        content: [{ type: "text", text: "Second thought" }],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    // Should be merged into 2 messages: user + single merged assistant
    expect(sent).toHaveLength(2);
    expect(sent[0].role).toBe("user");
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content).toHaveLength(2);
    expect(sent[1].content[0].text).toBe("First response");
    expect(sent[1].content[1].text).toBe("Second thought");
  });

  test("consecutive real user messages are merged into one", async () => {
    // Same as above but for user messages — ensures the merge logic
    // handles both roles, not just assistant.
    const messages: Message[] = [
      userMsg("First question"),
      userMsg("Actually, also this"),
      assistantMsg("Response"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(sent).toHaveLength(2);
    expect(sent[0].role).toBe("user");
    expect(sent[0].content).toHaveLength(2);
    expect(sent[0].content[0].text).toBe("First question");
    expect(sent[0].content[1].text).toBe("Actually, also this");
    expect(sent[1].role).toBe("assistant");
  });

  test("three consecutive text-only assistant messages are all merged into one", async () => {
    // Regression test: after merging messages[i-1] and messages[i], the
    // element formerly at i+1 shifts to i, forming a new same-role pair.
    // The while loop must recheck that position rather than walking past it.
    const messages: Message[] = [
      userMsg("Start"),
      assistantMsg("Response A"),
      assistantMsg("Hint B"),
      assistantMsg("Hint C"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(sent).toHaveLength(2);
    expect(sent[0].role).toBe("user");
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content).toHaveLength(3);
    expect(sent[1].content[0].text).toBe("Response A");
    expect(sent[1].content[1].text).toBe("Hint B");
    expect(sent[1].content[2].text).toBe("Hint C");
  });

  test("streams normal text through without delay when text is not a sentinel prefix", async () => {
    scriptedStream = [
      { kind: "blockStart" },
      { kind: "text", text: "Hello world" },
      { kind: "blockStop" },
    ];
    const emitted: string[] = [];
    await provider.sendMessage([userMsg("Hi")], {
      onEvent: (event) => {
        if (event.type === "text_delta") {
          emitted.push(event.text);
        }
      },
    });
    expect(emitted).toEqual(["Hello world"]);
  });

  test("suppresses placeholder sentinel streamed as a single chunk", async () => {
    // Model echoes a sentinel in one chunk; buffer should hold it and
    // drop it on content_block_stop since it matches exactly.
    scriptedStream = [
      { kind: "blockStart" },
      { kind: "text", text: PLACEHOLDER_EMPTY_TURN },
      { kind: "blockStop" },
    ];
    const emitted: string[] = [];
    await provider.sendMessage([userMsg("Hi")], {
      onEvent: (event) => {
        if (event.type === "text_delta") {
          emitted.push(event.text);
        }
      },
    });
    expect(emitted).toEqual([]);
  });

  test("suppresses bare-variant sentinel streamed as a single chunk", async () => {
    scriptedStream = [
      { kind: "blockStart" },
      { kind: "text", text: "__PLACEHOLDER__[empty assistant turn]" },
      { kind: "blockStop" },
    ];
    const emitted: string[] = [];
    await provider.sendMessage([userMsg("Hi")], {
      onEvent: (event) => {
        if (event.type === "text_delta") {
          emitted.push(event.text);
        }
      },
    });
    expect(emitted).toEqual([]);
  });

  test("suppresses placeholder sentinel streamed across multiple chunks", async () => {
    scriptedStream = [
      { kind: "blockStart" },
      { kind: "text", text: "\x00__PLACE" },
      { kind: "text", text: "HOLDER__[empty" },
      { kind: "text", text: " assistant turn]" },
      { kind: "blockStop" },
    ];
    const emitted: string[] = [];
    await provider.sendMessage([userMsg("Hi")], {
      onEvent: (event) => {
        if (event.type === "text_delta") {
          emitted.push(event.text);
        }
      },
    });
    expect(emitted).toEqual([]);
  });

  test("suppresses a leading-space-corrupted sentinel echo (proxy dropped the guard byte)", async () => {
    // OpenRouter's Anthropic-compat path returns the `\x00` guard as a leading
    // space; the normalized prefix check must still hold and drop it.
    scriptedStream = [
      { kind: "blockStart" },
      { kind: "text", text: " __PLACEHOLDER__[empty assistant turn]" },
      { kind: "blockStop" },
    ];
    const emitted: string[] = [];
    await provider.sendMessage([userMsg("Hi")], {
      onEvent: (event) => {
        if (event.type === "text_delta") {
          emitted.push(event.text);
        }
      },
    });
    expect(emitted).toEqual([]);
  });

  test("suppresses a leading-space-corrupted sentinel split across chunks", async () => {
    scriptedStream = [
      { kind: "blockStart" },
      { kind: "text", text: " __PLACE" },
      { kind: "text", text: "HOLDER__[empty assistant turn]" },
      { kind: "blockStop" },
    ];
    const emitted: string[] = [];
    await provider.sendMessage([userMsg("Hi")], {
      onEvent: (event) => {
        if (event.type === "text_delta") {
          emitted.push(event.text);
        }
      },
    });
    expect(emitted).toEqual([]);
  });

  test("still streams real text that begins with whitespace", async () => {
    scriptedStream = [
      { kind: "blockStart" },
      { kind: "text", text: " hello there" },
      { kind: "blockStop" },
    ];
    const emitted: string[] = [];
    await provider.sendMessage([userMsg("Hi")], {
      onEvent: (event) => {
        if (event.type === "text_delta") {
          emitted.push(event.text);
        }
      },
    });
    expect(emitted.join("")).toBe(" hello there");
  });

  test("flushes buffered prefix when the continuation diverges from all sentinels", async () => {
    // "__PLACEHOLDER__" is a prefix of the sentinels, so it stays buffered.
    // Once the next chunk diverges (bracket instead of the expected opening),
    // the buffer must flush.
    scriptedStream = [
      { kind: "blockStart" },
      { kind: "text", text: "__PLACEHOLDER__" },
      { kind: "text", text: " is bold in markdown" },
      { kind: "blockStop" },
    ];
    const emitted: string[] = [];
    await provider.sendMessage([userMsg("Hi")], {
      onEvent: (event) => {
        if (event.type === "text_delta") {
          emitted.push(event.text);
        }
      },
    });
    expect(emitted.join("")).toBe("__PLACEHOLDER__ is bold in markdown");
  });

  test("flushes non-sentinel residual buffer at content_block_stop", async () => {
    // If the stream ends mid-prefix, the residual must be flushed (the
    // accumulated text isn't a complete sentinel, so it's real content).
    scriptedStream = [
      { kind: "blockStart" },
      { kind: "text", text: "__PLACEHOLDER__" },
      { kind: "blockStop" },
    ];
    const emitted: string[] = [];
    await provider.sendMessage([userMsg("Hi")], {
      onEvent: (event) => {
        if (event.type === "text_delta") {
          emitted.push(event.text);
        }
      },
    });
    expect(emitted).toEqual(["__PLACEHOLDER__"]);
  });

  test("resets buffer across content blocks so a sentinel in one block doesn't poison the next", async () => {
    scriptedStream = [
      { kind: "blockStart" },
      { kind: "text", text: PLACEHOLDER_EMPTY_TURN },
      { kind: "blockStop" },
      { kind: "blockStart" },
      { kind: "text", text: "Fresh block content" },
      { kind: "blockStop" },
    ];
    const emitted: string[] = [];
    await provider.sendMessage([userMsg("Hi")], {
      onEvent: (event) => {
        if (event.type === "text_delta") {
          emitted.push(event.text);
        }
      },
    });
    expect(emitted).toEqual(["Fresh block content"]);
  });

  test("isPlaceholderSentinelText matches sentinel with and without the null-byte prefix", () => {
    // The runtime filter must be lenient enough to catch sentinel text that
    // lost its `\x00` prefix in transit (e.g. a model echoing it back from
    // input history without reproducing the control character). Migration 222
    // handles the same two variants.
    expect(isPlaceholderSentinelText(PLACEHOLDER_EMPTY_TURN)).toBe(true);
    expect(isPlaceholderSentinelText(PLACEHOLDER_BLOCKS_OMITTED)).toBe(true);
    expect(
      isPlaceholderSentinelText("__PLACEHOLDER__[empty assistant turn]"),
    ).toBe(true);
    expect(
      isPlaceholderSentinelText("__PLACEHOLDER__[internal blocks omitted]"),
    ).toBe(true);
    // Nearby strings must NOT match — guard against over-broad matching.
    expect(isPlaceholderSentinelText("")).toBe(false);
    expect(isPlaceholderSentinelText("__PLACEHOLDER__")).toBe(false);
    expect(
      isPlaceholderSentinelText("prefix __PLACEHOLDER__[empty assistant turn]"),
    ).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Workspace context injection + cache control
  // -----------------------------------------------------------------------

  test("carryover with tool_result-only user turn emits synthetic user message", async () => {
    // This tests the fix for consecutive assistant messages when:
    // - assistant has both tool_use blocks and trailing non-tool blocks (carryover)
    // - following user message contains ONLY tool_result blocks (no other content)
    const messages: Message[] = [
      userMsg("Read file"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "file_read", input: {} },
          { type: "text", text: "Checking the file now." }, // carryover content
        ],
      },
      {
        role: "user",
        content: [
          // ONLY tool_result, no other content
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "file contents",
            is_error: false,
          },
        ],
      },
      assistantMsg("Next response"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string; tool_use_id?: string }>;
    }>;

    // Expected structure:
    // 1. user(Read file)
    // 2. assistant(tool_use)
    // 3. user(tool_result)
    // 4. assistant(Checking the file now.)
    // 5. user(<synthetic_continuation __injected />)  <-- synthetic user message to maintain alternation
    // 6. assistant(Next response)
    expect(sent).toHaveLength(6);
    expect(sent[0].role).toBe("user");
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content[0].type).toBe("tool_use");
    expect(sent[2].role).toBe("user");
    expect(sent[2].content[0].type).toBe("tool_result");
    expect(sent[3].role).toBe("assistant");
    expect(sent[3].content[0].type).toBe("text");
    expect(sent[3].content[0].text).toBe("Checking the file now.");
    expect(sent[4].role).toBe("user");
    expect(sent[4].content[0].type).toBe("text");
    expect(sent[4].content[0].text).toBe(
      "<synthetic_continuation __injected />",
    );
    expect(sent[5].role).toBe("assistant");
    expect(sent[5].content[0].text).toBe("Next response");
  });

  test("carryover with tool_result-only user turn skips synthetic when next message is user", async () => {
    // When the user turn after the consumed pair is already a user message,
    // the synthetic continuation is unnecessary — the next user message
    // naturally maintains alternation after the carryover assistant message.
    const messages: Message[] = [
      userMsg("Read file"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "file_read", input: {} },
          { type: "text", text: "Checking the file now." }, // carryover content
        ],
      },
      {
        role: "user",
        content: [
          // ONLY tool_result, no other content
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "file contents",
            is_error: false,
          },
        ],
      },
      userMsg("Follow-up question"), // next message is user — no synthetic needed
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string; tool_use_id?: string }>;
    }>;

    // Expected structure:
    // 1. user(Read file)
    // 2. assistant(tool_use)
    // 3. user(tool_result)
    // 4. assistant(Checking the file now.)
    // 5. user(Follow-up question)  <-- real user message, NO synthetic continuation
    expect(sent).toHaveLength(5);
    expect(sent[0].role).toBe("user");
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].content[0].type).toBe("tool_use");
    expect(sent[2].role).toBe("user");
    expect(sent[2].content[0].type).toBe("tool_result");
    expect(sent[3].role).toBe("assistant");
    expect(sent[3].content[0].text).toBe("Checking the file now.");
    expect(sent[4].role).toBe("user");
    expect(sent[4].content[0].text).toBe("Follow-up question");
  });

  test("multi-turn with workspace injection: prev-turn + last user message get 1h cache", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<workspace>\nRoot: /sandbox\nDirectories: src\n</workspace>",
          },
          { type: "text", text: "Turn 1" },
        ],
      },
      assistantMsg("Response 1"),
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<workspace>\nRoot: /sandbox\nDirectories: src, lib\n</workspace>",
          },
          { type: "text", text: "Turn 2" },
        ],
      },
      assistantMsg("Response 2"),
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<workspace>\nRoot: /sandbox\nDirectories: src, lib, docs\n</workspace>",
          },
          { type: "text", text: "Turn 3" },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;
    const userMsgs = sent.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(3);

    // Oldest user message (turn 1): no cache_control
    for (const block of userMsgs[0].content) {
      expect(block.cache_control).toBeUndefined();
    }

    // Previous-turn anchor (turn 2): 1h cache on last block to preserve the
    // cached prefix across turn transitions
    const prevTurn = userMsgs[userMsgs.length - 2];
    expect(prevTurn.content[0].cache_control).toBeUndefined();
    expect(prevTurn.content[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    // Current-turn anchor (turn 3): 1h cache on last block
    const lastUser = userMsgs[userMsgs.length - 1];
    expect(lastUser.content[0].cache_control).toBeUndefined();
    expect(lastUser.content[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    // No top-level cache_control — breakpoints are set directly on blocks
    expect(
      (lastStreamParams as Record<string, unknown>).cache_control,
    ).toBeUndefined();
  });

  test("tool loop: turn-starting user message gets 1h cache, last tool_result gets 5m advancing tail", async () => {
    const messages: Message[] = [
      userMsg("Read the config file"),
      toolUseMsg("tu_1", "file_read"),
      toolResultMsg("tu_1", "config contents here"),
      toolUseMsg("tu_2", "file_read"),
      toolResultMsg("tu_2", "more contents"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        text?: string;
        cache_control?: { type: string; ttl?: string };
      }>;
    }>;

    // First message is the turn-starting user text — gets 1h cache
    expect(sent[0].role).toBe("user");
    expect(sent[0].content[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    // Non-last tool result messages do NOT get cache_control
    const toolResultMsgs = sent.filter(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.every(
          (b) => typeof b !== "string" && b.type === "tool_result",
        ),
    );
    expect(toolResultMsgs.length).toBeGreaterThan(0);
    for (const tr of toolResultMsgs.slice(0, -1)) {
      for (const block of tr.content) {
        expect(block.cache_control).toBeUndefined();
      }
    }

    // Last message gets 5m advancing tail cache on its last block
    const lastMsg = sent[sent.length - 1];
    const lastBlock = lastMsg.content[lastMsg.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  // -----------------------------------------------------------------------
  // is_error + contentBlocks — non-text blocks must be stripped
  // -----------------------------------------------------------------------

  test("is_error tool_result strips non-text contentBlocks (images)", async () => {
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_img", "file_read"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_img",
            content: "Error: file not found",
            is_error: true,
            contentBlocks: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBOR",
                },
              },
              { type: "text", text: "extra error detail" },
            ],
          },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        is_error?: boolean;
        content?: unknown;
      }>;
    }>;

    const toolResult = sent[2].content.find(
      (b) => b.type === "tool_result" && b.tool_use_id === "tu_img",
    )!;
    expect(toolResult.is_error).toBe(true);

    // Content should be an array with only text blocks (no images)
    const parts = toolResult.content as Array<{ type: string }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.every((p) => p.type === "text")).toBe(true);
    // Original text + the extra text contentBlock
    expect(parts).toHaveLength(2);
  });

  test("is_error tool_result with only image contentBlocks falls back to text-only", async () => {
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_img2", "file_read"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_img2",
            content: "Error: file not found",
            is_error: true,
            contentBlocks: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBOR",
                },
              },
            ],
          },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        is_error?: boolean;
        content?: unknown;
      }>;
    }>;

    const toolResult = sent[2].content.find(
      (b) => b.type === "tool_result" && b.tool_use_id === "tu_img2",
    )!;
    expect(toolResult.is_error).toBe(true);

    // All images stripped → no usable blocks → falls back to text-only content
    expect(toolResult.content).toBe("Error: file not found");
  });

  test("non-error tool_result preserves image contentBlocks", async () => {
    const messages: Message[] = [
      userMsg("Do something"),
      toolUseMsg("tu_img3", "file_read"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_img3",
            content: "Success",
            is_error: false,
            contentBlocks: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBOR",
                },
              },
            ],
          },
        ],
      },
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        tool_use_id?: string;
        is_error?: boolean;
        content?: unknown;
      }>;
    }>;

    const toolResult = sent[2].content.find(
      (b) => b.type === "tool_result" && b.tool_use_id === "tu_img3",
    )!;
    expect(toolResult.is_error).toBe(false);

    // Non-error: images should be preserved in the content array
    const parts = toolResult.content as Array<{ type: string }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.some((p) => p.type === "image")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — Managed Proxy Fallback
// ---------------------------------------------------------------------------

describe("AnthropicProvider — Managed Proxy Fallback", () => {
  beforeEach(() => {
    lastStreamParams = null;
    _lastStreamOptions = null;
    lastConstructorArgs = null;
  });

  test("constructor passes baseURL to Anthropic SDK when provided", () => {
    new AnthropicProvider("managed-key", "claude-sonnet-4-6", {
      baseURL: "https://platform.example.com/v1/runtime-proxy/anthropic",
    });

    expect(lastConstructorArgs).not.toBeNull();
    expect(lastConstructorArgs!.apiKey).toBe("managed-key");
    expect(lastConstructorArgs!.baseURL).toBe(
      "https://platform.example.com/v1/runtime-proxy/anthropic",
    );
  });

  test("constructor does not set baseURL when option is omitted", () => {
    new AnthropicProvider("sk-ant-user-key", "claude-sonnet-4-6");

    expect(lastConstructorArgs).not.toBeNull();
    expect(lastConstructorArgs!.apiKey).toBe("sk-ant-user-key");
    expect(lastConstructorArgs!.baseURL).toBeUndefined();
  });

  test("managed mode provider preserves tool-pairing behavior", async () => {
    const provider = new AnthropicProvider("managed-key", "claude-sonnet-4-6", {
      baseURL: "https://platform.example.com/v1/runtime-proxy/anthropic",
    });

    const messages: Message[] = [
      userMsg("Read file"),
      toolUseMsg("tu_1", "file_read"),
      toolResultMsg("tu_1", "file contents"),
    ];
    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;

    expect(sent).toHaveLength(3);
    const toolResults = sent[2].content.filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe("tu_1");
  });

  test("managed mode provider preserves cache-control behavior", async () => {
    const provider = new AnthropicProvider("managed-key", "claude-sonnet-4-6", {
      baseURL: "https://platform.example.com/v1/runtime-proxy/anthropic",
    });

    await provider.sendMessage([userMsg("Hi")], {
      tools: sampleTools,
      systemPrompt: "You are helpful.",
    });

    // System prompt cache control
    const system = lastStreamParams!.system as Array<{
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Last tool cache control
    const tools = lastStreamParams!.tools as Array<{
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(tools[tools.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — Orphaned UTF-16 surrogate sanitization
// ---------------------------------------------------------------------------

describe("AnthropicProvider — surrogate sanitization", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    lastStreamParams = null;
    provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
  });

  test("strips orphaned high surrogate from a tool result before sending", async () => {
    // An orphaned high surrogate — the exact shape that triggers Anthropic's
    // "no low surrogate in string" 400. The mock's JSON.parse(JSON.stringify)
    // on line ~44 would throw if sanitization didn't happen.
    const LONE_HIGH = "\uD83C";
    const messages: Message[] = [
      toolUseMsg("tu1", "bash"),
      toolResultMsg("tu1", `shell output ${LONE_HIGH} more output`),
      userMsg("what happened?"),
    ];

    await provider.sendMessage(messages);

    const sent = lastStreamParams!.messages as Array<{
      role: string;
      content: Array<{ type: string; content?: string; text?: string }>;
    }>;
    // Find the tool_result block in the captured payload and assert no orphans.
    const toolResult = sent
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.content).toBeDefined();
    const content = toolResult!.content as string;
    for (let i = 0; i < content.length; i++) {
      const code = content.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = i + 1 < content.length ? content.charCodeAt(i + 1) : 0;
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i++;
      } else {
        expect(code < 0xdc00 || code > 0xdfff).toBe(true);
      }
    }
  });

  test("clean payloads are not copied unnecessarily", async () => {
    // When there are no orphans, the sanitizer should be a no-op. We can't
    // easily assert reference equality through the mock boundary (the mock
    // JSON-round-trips params for capture), but we can at least confirm the
    // call succeeds without error on ordinary payloads containing valid
    // surrogate pairs (emoji).
    const EMOJI = "\uD83C\uDF89";
    await provider.sendMessage([userMsg(`hello ${EMOJI} world`)]);
    const sent = lastStreamParams!.messages as Array<{
      content: Array<{ text?: string }>;
    }>;
    expect(sent[0].content[0].text).toContain(EMOJI);
  });
});

// ---------------------------------------------------------------------------
// Haiku model gating
// ---------------------------------------------------------------------------

describe("AnthropicProvider — Haiku Model Gating", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    lastStreamParams = null;
    _lastStreamOptions = null;
    lastConstructorArgs = null;
    provider = new AnthropicProvider(
      "sk-ant-test",
      "claude-haiku-4-5-20251001",
    );
  });

  test("max_tokens defaults to 8192 for Haiku", async () => {
    await provider.sendMessage([userMsg("Hi")], {
      systemPrompt: "You are helpful.",
    });

    expect(lastStreamParams!.max_tokens).toBe(8192);
  });

  test("caller max_tokens is clamped to 8192 for Haiku", async () => {
    await provider.sendMessage([userMsg("Hi")], {
      systemPrompt: "You are helpful.",
      config: { max_tokens: 64000 },
    });

    expect(lastStreamParams!.max_tokens).toBe(8192);
  });

  test("caller max_tokens below 8192 is preserved for Haiku", async () => {
    await provider.sendMessage([userMsg("Hi")], {
      systemPrompt: "You are helpful.",
      config: { max_tokens: 128 },
    });

    expect(lastStreamParams!.max_tokens).toBe(128);
  });

  test("non-Haiku provider respects caller max_tokens without clamping", async () => {
    const sonnetProvider = new AnthropicProvider(
      "sk-ant-test",
      "claude-sonnet-4-6",
    );
    await sonnetProvider.sendMessage([userMsg("Hi")], {
      systemPrompt: "You are helpful.",
      config: { max_tokens: 200 },
    });

    expect(lastStreamParams!.max_tokens).toBe(200);
  });

  test("cache_control omits ttl for Haiku", async () => {
    await provider.sendMessage([userMsg("Hi")], {
      systemPrompt: "You are helpful.",
    });

    const system = lastStreamParams!.system as Array<{
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[0].cache_control).not.toHaveProperty("ttl");
  });

  test("betas array is empty for Haiku (no extended cache TTL)", async () => {
    await provider.sendMessage([userMsg("Hi")], {
      systemPrompt: "You are helpful.",
    });

    // When betas is empty, the non-beta stream path is used, so no betas
    // field should appear in lastStreamParams.
    expect(lastStreamParams!.betas).toBeUndefined();
  });

  test("effort is stripped for Haiku even when provided in config", async () => {
    await provider.sendMessage([userMsg("Hi")], {
      systemPrompt: "You are helpful.",
      config: { effort: "high" },
    });

    expect(lastStreamParams!.output_config).toBeUndefined();
  });

  test('effort: "none" omits output_config.effort on non-Haiku models', async () => {
    const sonnetProvider = new AnthropicProvider(
      "sk-ant-test",
      "claude-sonnet-4-6",
    );
    await sonnetProvider.sendMessage([userMsg("Hi")], {
      systemPrompt: "You are helpful.",
      config: { effort: "none" },
    });

    // mergedOutputConfig is empty when effort is "none" and no other
    // output_config fields were supplied, so output_config is not attached
    // to the request at all.
    expect(lastStreamParams!.output_config).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OpenRouter routing Anthropic models through the Messages API
// ---------------------------------------------------------------------------

describe("OpenRouterProvider — Anthropic dispatch", () => {
  beforeEach(() => {
    lastStreamParams = null;
    _lastStreamOptions = null;
    lastConstructorArgs = null;
  });

  test("anthropic/ models are routed to Anthropic Messages API with Bearer auth", async () => {
    const { OpenRouterProvider } =
      await import("../providers/openrouter/client.js");
    const provider = new OpenRouterProvider(
      "or-key",
      "anthropic/claude-sonnet-4.6",
    );
    await provider.sendMessage([userMsg("hi")], {
      systemPrompt: "You are helpful.",
    });

    expect(lastConstructorArgs).toMatchObject({
      apiKey: null,
      authToken: "or-key",
      baseURL: "https://openrouter.ai/api",
    });
    expect(lastStreamParams).toBeTruthy();
    expect(lastStreamParams!.model).toBe("anthropic/claude-sonnet-4.6");
  });

  test("custom baseURL has trailing /v1 stripped for Messages API", async () => {
    const { OpenRouterProvider } =
      await import("../providers/openrouter/client.js");
    const provider = new OpenRouterProvider(
      "ast-key",
      "anthropic/claude-opus-4.6",
      {
        baseURL: "https://platform.example.com/v1/runtime-proxy/openrouter/v1",
      },
    );
    await provider.sendMessage([userMsg("hi")]);

    expect(lastConstructorArgs).toMatchObject({
      baseURL: "https://platform.example.com/v1/runtime-proxy/openrouter",
    });
  });

  test("thinking config flows through to Anthropic Messages API natively", async () => {
    const { OpenRouterProvider } =
      await import("../providers/openrouter/client.js");
    const provider = new OpenRouterProvider(
      "or-key",
      "anthropic/claude-sonnet-4.6",
    );
    await provider.sendMessage([userMsg("hi")], {
      config: { thinking: { type: "adaptive" } },
    });

    expect(lastStreamParams!.thinking).toEqual({ type: "adaptive" });
    // The OpenAI-compat `reasoning` parameter must NOT be sent on the
    // native Messages API path.
    expect(lastStreamParams!.reasoning).toBeUndefined();
  });

  test("disabled thinking config flows through to Anthropic Messages API natively", async () => {
    const { OpenRouterProvider } =
      await import("../providers/openrouter/client.js");
    const provider = new OpenRouterProvider(
      "or-key",
      "anthropic/claude-sonnet-4.6",
    );
    await provider.sendMessage([userMsg("hi")], {
      config: { thinking: { type: "disabled" } },
    });

    expect(lastStreamParams!.thinking).toEqual({ type: "disabled" });
    expect(lastStreamParams!.reasoning).toBeUndefined();
  });

  test("sends OpenRouter app-attribution headers on Anthropic-compatible requests", async () => {
    const { OpenRouterProvider } =
      await import("../providers/openrouter/client.js");
    const provider = new OpenRouterProvider(
      "or-key",
      "anthropic/claude-sonnet-4.6",
    );
    await provider.sendMessage([userMsg("hi")], {
      config: {
        usageAttributionHeaders: {
          "Vellum-Organization-Id": "org-123",
        },
      },
    });

    expect(_lastStreamOptions?.headers).toEqual(
      expect.objectContaining({
        "HTTP-Referer": "https://www.vellum.ai",
        "X-OpenRouter-Title": "Vellum Assistant",
        "X-OpenRouter-Categories": "personal-agent,cli-agent",
        "Vellum-Organization-Id": "org-123",
      }),
    );
    expect(lastStreamParams).not.toHaveProperty("HTTP-Referer");
    expect(lastStreamParams).not.toHaveProperty("X-OpenRouter-Title");
    expect(lastStreamParams).not.toHaveProperty("X-OpenRouter-Categories");
    expect(lastStreamParams).not.toHaveProperty("usageAttributionHeaders");
  });

  test("per-request model override routes based on the overridden model", async () => {
    const { OpenRouterProvider } =
      await import("../providers/openrouter/client.js");
    // Default model is non-Anthropic, but the request overrides with an
    // Anthropic model — dispatch must honour the request-level model.
    const provider = new OpenRouterProvider("or-key", "x-ai/grok-4");
    await provider.sendMessage([userMsg("hi")], {
      config: { model: "anthropic/claude-haiku-4.5" },
    });

    expect(lastStreamParams).toBeTruthy();
    expect(lastStreamParams!.model).toBe("anthropic/claude-haiku-4.5");
  });
});

// ---------------------------------------------------------------------------
// Thinking block send-time filtering
// ---------------------------------------------------------------------------

describe("AnthropicProvider — thinking block send-time filtering", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    lastStreamParams = null;
    _lastStreamOptions = null;
    lastConstructorArgs = null;
    scriptedStream = null;
    provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
  });

  function assistantThinkingMsg(
    thinking: string,
    signature: string,
    text: string,
  ): Message {
    return {
      role: "assistant",
      content: [
        { type: "thinking", thinking, signature },
        { type: "text", text },
      ],
    };
  }

  function assistantThinkingToolUseMsg(
    thinking: string,
    signature: string,
    toolUseId: string,
    toolName: string,
  ): Message {
    return {
      role: "assistant",
      content: [
        { type: "thinking", thinking, signature },
        { type: "tool_use", id: toolUseId, name: toolName, input: {} },
      ],
    };
  }

  function assistantRedactedThinkingMsg(data: string, text: string): Message {
    return {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data },
        { type: "text", text },
      ],
    };
  }

  test("strips thinking blocks from completed historical assistant turns", async () => {
    const messages: Message[] = [
      userMsg("What is 2+2?"),
      assistantThinkingMsg("let me think...", "sig-abc-old", "4"),
      userMsg("And what is 3+3?"),
    ];

    await provider.sendMessage(messages, {
      tools: sampleTools,
      systemPrompt: "system",
    });
    expect(lastStreamParams).toBeTruthy();

    const sent = lastStreamParams!.messages as Anthropic.MessageParam[];
    const assistantTurn = sent.find((m) => m.role === "assistant");
    expect(assistantTurn).toBeTruthy();

    const blocks = assistantTurn!.content as Anthropic.ContentBlockParam[];
    const thinkingBlocks = blocks.filter(
      (b) => typeof b !== "string" && b.type === "thinking",
    );
    expect(thinkingBlocks).toHaveLength(0);

    const textBlocks = blocks.filter(
      (b) => typeof b !== "string" && b.type === "text",
    );
    expect(textBlocks).toHaveLength(1);
  });

  test("strips redacted_thinking blocks from completed historical turns", async () => {
    const messages: Message[] = [
      userMsg("What is 2+2?"),
      assistantRedactedThinkingMsg("encrypted-data-xyz", "4"),
      userMsg("And what is 3+3?"),
    ];

    await provider.sendMessage(messages, {
      tools: sampleTools,
      systemPrompt: "system",
    });
    expect(lastStreamParams).toBeTruthy();

    const sent = lastStreamParams!.messages as Anthropic.MessageParam[];
    const assistantTurn = sent.find((m) => m.role === "assistant");
    expect(assistantTurn).toBeTruthy();

    const blocks = assistantTurn!.content as Anthropic.ContentBlockParam[];
    const redactedBlocks = blocks.filter(
      (b) => typeof b !== "string" && b.type === "redacted_thinking",
    );
    expect(redactedBlocks).toHaveLength(0);
  });

  test("preserves thinking blocks in active tool-use continuation span", async () => {
    const messages: Message[] = [
      userMsg("Read the file"),
      assistantThinkingToolUseMsg(
        "I should read the file",
        "sig-valid-123",
        "tu-1",
        "file_read",
      ),
      toolResultMsg("tu-1", "file contents here"),
    ];

    await provider.sendMessage(messages, {
      tools: sampleTools,
      systemPrompt: "system",
    });
    expect(lastStreamParams).toBeTruthy();

    const sent = lastStreamParams!.messages as Anthropic.MessageParam[];
    const assistantTurn = sent.find((m) => m.role === "assistant");
    expect(assistantTurn).toBeTruthy();

    const blocks = assistantTurn!.content as Anthropic.ContentBlockParam[];
    const thinkingBlocks = blocks.filter(
      (b) => typeof b !== "string" && b.type === "thinking",
    );
    expect(thinkingBlocks).toHaveLength(1);
    expect((thinkingBlocks[0] as { signature: string }).signature).toBe(
      "sig-valid-123",
    );
  });

  test("strips historical thinking but preserves active continuation in same conversation", async () => {
    const messages: Message[] = [
      // Completed historical turn
      userMsg("What is 2+2?"),
      assistantThinkingMsg("old thinking", "sig-old-stale", "4"),
      // Active tool-use continuation
      userMsg("Now read the file"),
      assistantThinkingToolUseMsg(
        "current thinking",
        "sig-current-valid",
        "tu-2",
        "file_read",
      ),
      toolResultMsg("tu-2", "file contents"),
    ];

    await provider.sendMessage(messages, {
      tools: sampleTools,
      systemPrompt: "system",
    });
    expect(lastStreamParams).toBeTruthy();

    const sent = lastStreamParams!.messages as Anthropic.MessageParam[];
    const assistantTurns = sent.filter((m) => m.role === "assistant");
    expect(assistantTurns.length).toBeGreaterThanOrEqual(2);

    // Historical turn: thinking stripped
    const historicalBlocks = assistantTurns[0]
      .content as Anthropic.ContentBlockParam[];
    const historicalThinking = historicalBlocks.filter(
      (b) => typeof b !== "string" && b.type === "thinking",
    );
    expect(historicalThinking).toHaveLength(0);

    // Active turn: thinking preserved
    const activeBlocks = assistantTurns[1]
      .content as Anthropic.ContentBlockParam[];
    const activeThinking = activeBlocks.filter(
      (b) => typeof b !== "string" && b.type === "thinking",
    );
    expect(activeThinking).toHaveLength(1);
    expect((activeThinking[0] as { signature: string }).signature).toBe(
      "sig-current-valid",
    );
  });

  test("uses placeholder when stripping thinking leaves assistant message empty", async () => {
    const messages: Message[] = [
      userMsg("Think about this"),
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm...", signature: "sig-x" }],
      },
      userMsg("What did you conclude?"),
    ];

    await provider.sendMessage(messages, {
      tools: sampleTools,
      systemPrompt: "system",
    });
    expect(lastStreamParams).toBeTruthy();

    const sent = lastStreamParams!.messages as Anthropic.MessageParam[];
    const assistantTurn = sent.find((m) => m.role === "assistant");
    expect(assistantTurn).toBeTruthy();

    const blocks = assistantTurn!.content as Anthropic.ContentBlockParam[];
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string; text: string }).type).toBe("text");
    expect(
      isPlaceholderSentinelText((blocks[0] as { text: string }).text),
    ).toBe(true);
  });

  test("multi-step tool-use chain preserves all thinking in the active span", async () => {
    const messages: Message[] = [
      // Completed historical turn
      userMsg("Hello"),
      assistantThinkingMsg("old thinking", "sig-old", "Hi there"),
      // Multi-step active tool-use chain
      userMsg("Do two things"),
      assistantThinkingToolUseMsg(
        "step 1 thinking",
        "sig-step1",
        "tu-a",
        "file_read",
      ),
      toolResultMsg("tu-a", "result a"),
      assistantThinkingToolUseMsg(
        "step 2 thinking",
        "sig-step2",
        "tu-b",
        "file_write",
      ),
      toolResultMsg("tu-b", "result b"),
    ];

    await provider.sendMessage(messages, {
      tools: sampleTools,
      systemPrompt: "system",
    });
    expect(lastStreamParams).toBeTruthy();

    const sent = lastStreamParams!.messages as Anthropic.MessageParam[];

    // Collect all thinking blocks across all assistant messages
    const allThinking: Anthropic.ContentBlockParam[] = [];
    for (const m of sent) {
      if (m.role !== "assistant") {
        continue;
      }
      const blocks = m.content as Anthropic.ContentBlockParam[];
      for (const b of blocks) {
        if (typeof b !== "string" && b.type === "thinking") {
          allThinking.push(b);
        }
      }
    }

    // Only the active span's thinking blocks should remain
    const signatures = allThinking.map(
      (b) => (b as { signature: string }).signature,
    );
    expect(signatures).not.toContain("sig-old");
    expect(signatures).toContain("sig-step1");
    expect(signatures).toContain("sig-step2");
  });
});

describe("AnthropicProvider — deprecated sampling params (temperature / top_p / top_k)", () => {
  beforeEach(() => {
    lastStreamParams = null;
  });

  // opus-4-7 / opus-4-8 / sonnet-5 (and, conservatively, fable) reject
  // `temperature`, `top_p`, and `top_k` with a 400; the provider must strip
  // all three. The OpenRouter `anthropic/...` form delegates here too.
  for (const model of [
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5",
    "anthropic/claude-sonnet-5",
    "claude-fable-5",
  ]) {
    test(`strips temperature, top_p, and top_k for ${model}`, async () => {
      const provider = new AnthropicProvider("sk-ant-test", model);
      await provider.sendMessage([userMsg("Hi")], {
        systemPrompt: "You are helpful.",
        config: { temperature: 0, top_p: 0.95, top_k: 40 },
      });
      expect(lastStreamParams!).not.toHaveProperty("temperature");
      expect(lastStreamParams!).not.toHaveProperty("top_p");
      expect(lastStreamParams!).not.toHaveProperty("top_k");
    });
  }

  // opus-4-6 / sonnet-4-6 still accept the params — they must pass through,
  // including `temperature: 0` (a value check, not truthiness).
  test("forwards temperature (including 0), top_p, and top_k for opus-4-6", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-opus-4-6");
    await provider.sendMessage([userMsg("Hi")], {
      systemPrompt: "You are helpful.",
      config: { temperature: 0, top_p: 0.95, top_k: 40 },
    });
    expect(lastStreamParams!.temperature).toBe(0);
    expect(lastStreamParams!.top_p).toBe(0.95);
    expect(lastStreamParams!.top_k).toBe(40);
  });

  test("forwards temperature, top_p, and top_k for sonnet-4-6", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
    await provider.sendMessage([userMsg("Hi")], {
      systemPrompt: "You are helpful.",
      config: { temperature: 0.7, top_p: 0.9, top_k: 20 },
    });
    expect(lastStreamParams!.temperature).toBe(0.7);
    expect(lastStreamParams!.top_p).toBe(0.9);
    expect(lastStreamParams!.top_k).toBe(20);
  });

  // A per-call model override targeting a deprecating model must win over the
  // provider's default (accepting) model.
  test("strips params when a per-call model override deprecates them", async () => {
    const provider = new AnthropicProvider("sk-ant-test", "claude-sonnet-4-6");
    await provider.sendMessage([userMsg("Hi")], {
      systemPrompt: "You are helpful.",
      config: {
        temperature: 0,
        top_p: 0.95,
        top_k: 40,
        model: "claude-opus-4-8",
      },
    });
    expect(lastStreamParams!).not.toHaveProperty("temperature");
    expect(lastStreamParams!).not.toHaveProperty("top_p");
    expect(lastStreamParams!).not.toHaveProperty("top_k");
  });
});
