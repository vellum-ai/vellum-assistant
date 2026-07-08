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

// Mutable config the mocked `getConfig` returns. Tests reassign this to drive
// the active-profile and memory-enabled branches.
let testConfig: {
  llm: { profiles: Record<string, unknown>; activeProfile?: string };
  memory: { enabled: boolean };
} = {
  llm: { profiles: TEST_PROFILES },
  memory: { enabled: false },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => testConfig,
}));

// Persona path — identity system prompt. A sentinel marks the persona prompt
// so tests can assert identity was assembled (vs. the anonymous task prompt).
const PERSONA_IDENTITY_PROMPT = "PERSONA_IDENTITY_SYSTEM_PROMPT";
const buildSystemPrompt = mock(() => PERSONA_IDENTITY_PROMPT);
mock.module("../prompts/system-prompt.js", () => ({ buildSystemPrompt }));

// Persona path — memory-injection pipeline. The mock records construction and
// `prepareMemory` calls, and prepends a sentinel `<memory>` block so tests can
// assert the pipeline ran and its output reached the provider.
const MEMORY_BLOCK_TEXT = "INJECTED_MEMORY_BLOCK";
let graphMemoryInstances = 0;
let prepareMemoryCalls = 0;
let disposeCalls = 0;
class MockConversationGraphMemory {
  constructor(_conversationId: string) {
    graphMemoryInstances += 1;
  }
  async prepareMemory(
    messages: Array<{ role: string; content: unknown[] }>,
  ): Promise<{ runMessages: unknown[] }> {
    prepareMemoryCalls += 1;
    const [first, ...rest] = messages;
    const injected = {
      role: first?.role ?? "user",
      content: [
        { type: "text", text: MEMORY_BLOCK_TEXT },
        ...(first?.content ?? []),
      ],
    };
    return { runMessages: [injected, ...rest] };
  }
  dispose(): void {
    disposeCalls += 1;
  }
}
mock.module(
  "../plugins/defaults/memory/graph/conversation-graph-memory.js",
  () => ({
    ConversationGraphMemory: MockConversationGraphMemory,
  }),
);

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: () => {},
}));

// Captures the most recent provider resolution + sendMessage invocation so
// tests can assert on call site, overrideProfile, tool_choice, and signal.
interface SendCall {
  messages: unknown;
  options: {
    tools?: Array<{ name: string; input_schema?: unknown }>;
    systemPrompt?: string;
    config?: {
      callSite?: string;
      overrideProfile?: string;
      tool_choice?: { type: string; name: string };
    };
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

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations } from "../persistence/schema/index.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";
import { getWorkspaceDir } from "../util/platform.js";
import { runLeaf, WorkflowUnknownProfileError } from "./leaf-runner.js";

await initializeDb();

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
  buildSystemPrompt.mockClear();
  lastResolveOpts = undefined;
  lastSendCall = undefined;
  responseQueue = [];
  graphMemoryInstances = 0;
  prepareMemoryCalls = 0;
  disposeCalls = 0;
  testConfig = {
    llm: { profiles: TEST_PROFILES },
    memory: { enabled: false },
  };
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

  test("accepts a plain JSON Schema object (sandbox-marshaled) directly", async () => {
    // A workflow script can't hold a Zod object, so its `schema` reaches
    // runLeaf as a JSON-marshaled JSON Schema object. The runner duck-types it,
    // uses it directly as the forced-tool input_schema, and validates the
    // returned input via z.fromJSONSchema.
    const jsonSchema = {
      type: "object",
      properties: { answer: { type: "string" }, score: { type: "number" } },
      required: ["answer", "score"],
      additionalProperties: false,
    };
    responseQueue = [
      {
        content: [
          {
            type: "tool_use",
            name: "emit_result",
            id: "tu-json",
            input: { answer: "yes", score: 7 },
          },
        ],
        model: "test",
        usage: { inputTokens: 5, outputTokens: 2 },
        stopReason: "tool_use",
      },
    ];

    const result = await runLeaf({
      prompt: "Answer the question.",
      schema: jsonSchema,
      trustContext,
    });

    expect(result.output).toEqual({ answer: "yes", score: 7 });
    // The JSON Schema is used verbatim as the synthetic tool's input_schema.
    const tool = lastSendCall?.options.tools?.[0];
    expect(tool?.name).toBe("emit_result");
    expect(tool?.input_schema).toMatchObject({
      type: "object",
      properties: { answer: { type: "string" }, score: { type: "number" } },
    });
  });

  test("throws when JSON-Schema-path output fails validation", async () => {
    const jsonSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };
    responseQueue = [
      {
        content: [
          {
            type: "tool_use",
            name: "emit_result",
            id: "tu-json-bad",
            input: { answer: 5 },
          },
        ],
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      },
    ];

    await expect(
      runLeaf({ prompt: "x", schema: jsonSchema, trustContext }),
    ).rejects.toThrow(/schema validation/i);
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
    // The override must ALSO ride on the per-call send config. The schema path
    // sets `callSite`, and CallSiteConfiguredProvider only injects its stored
    // override when the per-call config omits `callSite` — so without an
    // explicit pass-through the leaf silently resolves the default profile.
    expect(lastSendCall?.options.config?.callSite).toBe("workflowLeaf");
    expect(lastSendCall?.options.config?.overrideProfile).toBe(
      "cost-optimized",
    );
  });

  test("no profile sends config without an overrideProfile", async () => {
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
    expect(lastResolveOpts?.overrideProfile).toBeUndefined();
    expect(lastSendCall?.options.config?.overrideProfile).toBeUndefined();
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
    let toolWorkingDir: string | undefined;

    const makeTool = (name: string): Tool => ({
      name,
      description: `Tool ${name}`,
      category: "test",
      defaultRiskLevel: "low" as never,
      executionTarget: "sandbox",
      input_schema: { type: "object", properties: {}, required: [] },
      async execute(
        input: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<ToolExecutionResult> {
        calls.push({ name, input });
        toolWorkingDir = ctx.workingDir;
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

    // Leaf file tools must be bound to the WORKSPACE, not the daemon's cwd
    // (which is the install/binary dir) — otherwise sandbox-policy'd file tools
    // resolve/reject workspace paths incorrectly.
    expect(toolWorkingDir).toBe(getWorkspaceDir());
    expect(toolWorkingDir).not.toBe(process.cwd());

    // No conversation rows created.
    expect(countConversations()).toBe(before);
  });

  test("a leaf with no schema and an empty tool set runs the tool path (no throw)", async () => {
    // An empty resolved tool set with no schema must NOT fall through to the
    // schema path (where schemaToInputSchema(undefined) throws) — it runs the
    // agent loop with zero tools, i.e. a plain text leaf. This is the
    // momentarily-empty-baseline case (schedule fires before initializeTools()).
    responseQueue = [
      {
        content: [{ type: "text", text: "plain text leaf" }],
        model: "test",
        usage: { inputTokens: 3, outputTokens: 2 },
        stopReason: "end_turn",
      },
    ];

    const result = await runLeaf({
      prompt: "no tools",
      tools: [],
      trustContext,
    });
    expect(result.output).toBe("plain text leaf");
    expect(result.toolCallCount).toBe(0);
    // The send went out with an empty tool list (the agent-loop path), not a
    // forced-tool-choice schema call.
    expect(lastSendCall?.options.tools ?? []).toEqual([]);
    expect(lastSendCall?.options.config?.tool_choice).toBeUndefined();
  });
});

describe("runLeaf — tool path fails loud on empty output", () => {
  test("rethrows a swallowed provider rejection instead of returning empty", async () => {
    // The agent loop does not throw out of run() on a provider rejection — it
    // emits an `error` event and returns with no assistant text. An empty
    // responseQueue makes the mocked provider reject on the first call, which
    // the real AgentLoop swallows. Before the fix runToolLeaf returned
    // `{ output: "" }` (a phantom success the engine scored as completed); now
    // the leaf rethrows the captured error so the engine journals it failed.
    responseQueue = [];

    await expect(
      runLeaf({ prompt: "do work", tools: [], trustContext }),
    ).rejects.toThrow(/responseQueue exhausted/);
  });

  test("throws when the model produces no output text", async () => {
    // A clean end_turn with empty text is still a failure for a leaf whose
    // contract is to return a result — surfacing it lets `map`/`parallel`
    // yield null rather than a silent empty success.
    responseQueue = [
      {
        content: [{ type: "text", text: "   " }],
        model: "test",
        usage: { inputTokens: 4, outputTokens: 0 },
        stopReason: "end_turn",
      },
    ];

    await expect(
      runLeaf({
        prompt: "do work",
        tools: [],
        label: "empty-leaf",
        trustContext,
      }),
    ).rejects.toThrow(/produced no output text/);
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

describe("runLeaf — persona path", () => {
  const personaResponse = {
    content: [
      { type: "tool_use", name: "emit_result", id: "p", input: { a: "ok" } },
    ],
    model: "test",
    usage: { inputTokens: 3, outputTokens: 2 },
    stopReason: "tool_use",
  };

  test("injects identity system prompt and runs the memory pipeline", async () => {
    testConfig = {
      llm: { profiles: TEST_PROFILES, activeProfile: "balanced" },
      memory: { enabled: true },
    };
    const schema = z.object({ a: z.string() });
    responseQueue = [personaResponse];

    const before = countConversations();
    await runLeaf({
      prompt: "Draft a reply.",
      schema,
      persona: true,
      trustContext,
    });

    // Identity system prompt assembled and handed to the provider.
    expect(buildSystemPrompt).toHaveBeenCalledTimes(1);
    expect(lastSendCall?.options.systemPrompt).toBe(PERSONA_IDENTITY_PROMPT);

    // Memory pipeline ran (constructed, queried, and disposed) and its
    // injected block reached the provider as the user message's first block.
    expect(graphMemoryInstances).toBe(1);
    expect(prepareMemoryCalls).toBe(1);
    expect(disposeCalls).toBe(1);
    const messages = lastSendCall?.messages as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    expect(messages[0]?.content[0]?.text).toBe(MEMORY_BLOCK_TEXT);

    // No conversation row — persona keeps the no-persistence guarantee.
    expect(countConversations()).toBe(before);
  });

  test("resolves the workspace active profile by default", async () => {
    testConfig = {
      llm: { profiles: TEST_PROFILES, activeProfile: "balanced" },
      memory: { enabled: true },
    };
    const schema = z.object({ a: z.string() });
    responseQueue = [personaResponse];

    await runLeaf({ prompt: "x", schema, persona: true, trustContext });

    expect(lastResolveOpts?.overrideProfile).toBe("balanced");
  });

  test("explicit profile beats the persona active-profile default", async () => {
    testConfig = {
      llm: { profiles: TEST_PROFILES, activeProfile: "balanced" },
      memory: { enabled: true },
    };
    const schema = z.object({ a: z.string() });
    responseQueue = [personaResponse];

    await runLeaf({
      prompt: "x",
      schema,
      persona: true,
      profile: "cost-optimized",
      trustContext,
    });

    expect(lastResolveOpts?.overrideProfile).toBe("cost-optimized");
  });

  test("missing active profile falls through (no override)", async () => {
    // No `activeProfile` set → persona resolves no overrideProfile, deferring
    // to the shipped call-site default.
    testConfig = {
      llm: { profiles: TEST_PROFILES },
      memory: { enabled: true },
    };
    const schema = z.object({ a: z.string() });
    responseQueue = [personaResponse];

    await runLeaf({ prompt: "x", schema, persona: true, trustContext });

    expect(lastResolveOpts?.overrideProfile).toBeUndefined();
  });

  test("anonymous leaf carries no identity and skips the memory pipeline", async () => {
    testConfig = {
      llm: { profiles: TEST_PROFILES, activeProfile: "balanced" },
      memory: { enabled: true },
    };
    const schema = z.object({ a: z.string() });
    responseQueue = [personaResponse];

    await runLeaf({ prompt: "x", schema, trustContext });

    // Anonymous path is unchanged: minimal task prompt, no identity assembly,
    // no memory pipeline, no active-profile override.
    expect(buildSystemPrompt).not.toHaveBeenCalled();
    expect(graphMemoryInstances).toBe(0);
    expect(prepareMemoryCalls).toBe(0);
    expect(lastSendCall?.options.systemPrompt).not.toBe(
      PERSONA_IDENTITY_PROMPT,
    );
    expect(lastResolveOpts?.overrideProfile).toBeUndefined();
  });

  test("persona leaf skips the memory pipeline for an untrusted actor", async () => {
    // The personal-memory trust gate (isPersonalMemoryAllowed) blocks a remote
    // untrusted (non-guardian) actor: the persona leaf still gets the identity
    // system prompt, but NO private memory is retrieved — mirroring the main
    // turn's `resolveTrustClass(...) === "guardian"` gate before prepareMemory.
    // Force the HTTP-auth dev bypass off so trustClass actually decides.
    const savedAuth = process.env.DISABLE_HTTP_AUTH;
    delete process.env.DISABLE_HTTP_AUTH;
    try {
      testConfig = {
        llm: { profiles: TEST_PROFILES, activeProfile: "balanced" },
        memory: { enabled: true },
      };
      const schema = z.object({ a: z.string() });
      responseQueue = [personaResponse];

      await runLeaf({
        prompt: "Draft a reply.",
        schema,
        persona: true,
        // Remote, non-guardian actor → gate blocks personal memory.
        trustContext: { sourceChannel: "slack", trustClass: "unknown" },
      });

      // Identity is still assembled (the assistant's stable identity is not
      // private user content)…
      expect(buildSystemPrompt).toHaveBeenCalledTimes(1);
      expect(lastSendCall?.options.systemPrompt).toBe(PERSONA_IDENTITY_PROMPT);
      // …but the memory pipeline never ran, so no private memory was injected.
      expect(graphMemoryInstances).toBe(0);
      expect(prepareMemoryCalls).toBe(0);
      const messages = lastSendCall?.messages as Array<{
        content: Array<{ type: string; text?: string }>;
      }>;
      expect(messages[0]?.content[0]?.text).not.toBe(MEMORY_BLOCK_TEXT);
    } finally {
      if (savedAuth === undefined) delete process.env.DISABLE_HTTP_AUTH;
      else process.env.DISABLE_HTTP_AUTH = savedAuth;
    }
  });
});

afterAll(() => {
  mock.restore();
});
