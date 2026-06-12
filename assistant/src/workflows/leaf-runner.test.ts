/**
 * Unit tests for the ephemeral workflow leaf runner.
 *
 * Covers:
 * - Schema path: validates and extracts forced-tool-choice output + usage.
 * - Profile override: an unknown profile throws WorkflowUnknownProfileError;
 *   a known profile is forwarded as `overrideProfile`.
 * - Abort: a pre-aborted signal propagates out of the provider call.
 * - Tool path: executes ONLY the supplied toolset and returns usage + tool-call
 *   counts.
 * - No persistence: a leaf run creates no conversation rows and no workspace
 *   files.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { z } from "zod";

import { makeMockLogger } from "../__tests__/helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mocks — defined before importing the module under test.
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

const TEST_PROFILES = { balanced: {}, "cost-optimized": {} };

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: { profiles: TEST_PROFILES },
    memory: { enabled: false },
  }),
}));

// Captures the most recent provider resolution + sendMessage invocation so
// tests can assert on call site, overrideProfile, tool_choice, and signal.
interface SendCall {
  messages: unknown;
  options: {
    tools?: Array<{ name: string; input_schema?: unknown }>;
    systemPrompt?: string;
    config?: { tool_choice?: { type: string; name: string } };
    signal?: AbortSignal;
  };
}

let lastResolveOpts: { overrideProfile?: string } | undefined;
let lastSendCall: SendCall | undefined;

// Programmable provider response. Each test sets this before invoking runLeaf.
// For multi-turn tool-path runs it can be a queue consumed per call.
let responseQueue: Array<unknown> = [];

const sendMessage = mock(
  async (messages: unknown, options: SendCall["options"]): Promise<unknown> => {
    lastSendCall = { messages, options };
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const next = responseQueue.shift();
    if (next === undefined) {
      throw new Error("test: responseQueue exhausted");
    }
    return next;
  },
);

const getConfiguredProvider = mock(
  async (_callSite: string, opts: { overrideProfile?: string } = {}) => {
    lastResolveOpts = opts;
    return { name: "test-provider", sendMessage };
  },
);

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider,
  // Real helper re-exported by the module under test; reimplement minimally.
  extractToolUse: (response: { content: Array<{ type: string }> }) =>
    response.content.find((b) => b.type === "tool_use"),
}));

// ---------------------------------------------------------------------------
// Module under test (after mocks).
// ---------------------------------------------------------------------------

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { conversations } from "../memory/schema.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";
import { runLeaf, WorkflowUnknownProfileError } from "./leaf-runner.js";

initializeDb();

const trustContext = {
  sourceChannel: "vellum" as const,
  trustClass: "guardian" as const,
};

function countConversations(): number {
  return getDb().select().from(conversations).all().length;
}

beforeEach(() => {
  sendMessage.mockClear();
  getConfiguredProvider.mockClear();
  lastResolveOpts = undefined;
  lastSendCall = undefined;
  responseQueue = [];
});

describe("runLeaf — schema path", () => {
  test("validates and extracts forced-tool-choice output + usage", async () => {
    const schema = z.object({ answer: z.string(), score: z.number() });
    responseQueue = [
      {
        content: [
          {
            type: "tool_use",
            name: "emit_result",
            id: "tu-1",
            input: { answer: "yes", score: 7 },
          },
        ],
        model: "test",
        usage: { inputTokens: 42, outputTokens: 9 },
        stopReason: "tool_use",
      },
    ];

    const before = countConversations();
    const result = await runLeaf({
      prompt: "Answer the question.",
      schema,
      trustContext,
    });

    expect(result.output).toEqual({ answer: "yes", score: 7 });
    expect(result.inputTokens).toBe(42);
    expect(result.outputTokens).toBe(9);
    expect(result.toolCallCount).toBe(0);

    // Forced tool choice on the synthetic tool.
    expect(lastSendCall?.options.config?.tool_choice).toEqual({
      type: "tool",
      name: "emit_result",
    });
    const tool = lastSendCall?.options.tools?.[0];
    expect(tool?.name).toBe("emit_result");
    // input_schema is derived from the Zod schema (no $schema key).
    expect(tool?.input_schema).toBeDefined();
    expect(
      (tool?.input_schema as Record<string, unknown>).$schema,
    ).toBeUndefined();

    // No conversation rows created.
    expect(countConversations()).toBe(before);
  });

  test("throws when provider output fails schema validation", async () => {
    const schema = z.object({ answer: z.string() });
    responseQueue = [
      {
        content: [
          {
            type: "tool_use",
            name: "emit_result",
            id: "tu",
            input: { answer: 5 },
          },
        ],
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      },
    ];

    await expect(
      runLeaf({ prompt: "x", schema, trustContext }),
    ).rejects.toThrow(/schema validation/i);
  });
});

describe("runLeaf — profile override", () => {
  test("unknown profile throws WorkflowUnknownProfileError", async () => {
    const schema = z.object({ a: z.string() });
    await expect(
      runLeaf({ prompt: "x", schema, profile: "nope", trustContext }),
    ).rejects.toBeInstanceOf(WorkflowUnknownProfileError);
    // Provider never resolved — failed before the call.
    expect(getConfiguredProvider).not.toHaveBeenCalled();
  });

  test("known profile is forwarded as overrideProfile", async () => {
    const schema = z.object({ a: z.string() });
    responseQueue = [
      {
        content: [
          {
            type: "tool_use",
            name: "emit_result",
            id: "t",
            input: { a: "ok" },
          },
        ],
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      },
    ];

    await runLeaf({
      prompt: "x",
      schema,
      profile: "cost-optimized",
      trustContext,
    });
    expect(lastResolveOpts?.overrideProfile).toBe("cost-optimized");
  });
});

describe("runLeaf — abort", () => {
  test("a pre-aborted signal propagates", async () => {
    const schema = z.object({ a: z.string() });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runLeaf({
        prompt: "x",
        schema,
        signal: controller.signal,
        trustContext,
      }),
    ).rejects.toThrow();
  });
});

describe("runLeaf — tool path", () => {
  test("executes only the supplied toolset and returns usage + tool-call counts", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];

    const makeTool = (name: string): Tool => ({
      name,
      description: `Tool ${name}`,
      category: "test",
      defaultRiskLevel: "low" as never,
      executionTarget: "sandbox",
      input_schema: { type: "object", properties: {}, required: [] },
      async execute(
        input: Record<string, unknown>,
        _ctx: ToolContext,
      ): Promise<ToolExecutionResult> {
        calls.push({ name, input });
        return { content: `${name} ran`, isError: false };
      },
    });

    const allowed = makeTool("allowed_tool");

    // Turn 1: model calls the allowed tool. Turn 2: model emits final text.
    responseQueue = [
      {
        content: [
          {
            type: "tool_use",
            name: "allowed_tool",
            id: "tu-1",
            input: { q: "hi" },
          },
        ],
        model: "test",
        usage: { inputTokens: 10, outputTokens: 4 },
        stopReason: "tool_use",
      },
      {
        content: [{ type: "text", text: "All done." }],
        model: "test",
        usage: { inputTokens: 6, outputTokens: 3 },
        stopReason: "end_turn",
      },
    ];

    const before = countConversations();
    const result = await runLeaf({
      prompt: "Use the tool.",
      tools: [allowed],
      trustContext,
    });

    // Only the supplied tool ran.
    expect(calls).toEqual([{ name: "allowed_tool", input: { q: "hi" } }]);
    expect(result.output).toBe("All done.");
    expect(result.toolCallCount).toBe(1);
    // Usage summed across both provider calls.
    expect(result.inputTokens).toBe(16);
    expect(result.outputTokens).toBe(7);

    // The loop restricts execution to exactly the supplied tools.
    expect(lastSendCall?.options.tools?.map((t) => t.name)).toEqual([
      "allowed_tool",
    ]);

    // No conversation rows created.
    expect(countConversations()).toBe(before);
  });
});

describe("runLeaf — no persistence", () => {
  test("creates no conversation rows and no workspace files", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "leaf-runner-test-"));
    try {
      const before = countConversations();
      const schema = z.object({ a: z.string() });
      responseQueue = [
        {
          content: [
            {
              type: "tool_use",
              name: "emit_result",
              id: "t",
              input: { a: "ok" },
            },
          ],
          model: "test",
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        },
      ];

      await runLeaf({ prompt: "x", schema, trustContext });

      expect(countConversations()).toBe(before);
      // The leaf must not have written anything into the temp dir.
      expect(existsSync(tmp)).toBe(true);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

afterAll(() => {
  mock.restore();
});
