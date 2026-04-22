/**
 * Tests for the `tokenEstimate` plugin pipeline (PR 22 of the
 * agent-plugin-system plan).
 *
 * Covers:
 * - The default plugin's terminal middleware matches
 *   {@link estimatePromptTokensRaw} output exactly across a set of golden
 *   inputs (empty history, text-only, tools, provider-specific image sizing).
 * - Running the pipeline end-to-end with the default registered produces
 *   the same numeric result as calling `estimatePromptTokensRaw` directly.
 * - A custom plugin that short-circuits the chain can override the default,
 *   proving the extension point works.
 *
 * These tests exercise the registry + runner directly. They do not touch
 * `bootstrapPlugins` — the default registration path is covered by the
 * bootstrap suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  estimatePromptTokensRaw,
  estimateToolsTokens,
} from "../context/token-estimator.js";
import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import { defaultTokenEstimatePlugin } from "../plugins/defaults/token-estimate.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  EstimateArgs,
  EstimateResult,
  Middleware,
  Plugin,
  TurnContext,
} from "../plugins/types.js";
import type { Message, ToolDefinition } from "../providers/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-token-estimate-test",
    conversationId: "conv-token-estimate-test",
    turnIndex: 0,
    trust,
    ...overrides,
  };
}

const EMPTY_HISTORY: Message[] = [];

const TEXT_HISTORY: Message[] = [
  { role: "user", content: [{ type: "text", text: "hello there" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "hi! how can I help you today?" },
      { type: "text", text: "a second text block for good measure" },
    ],
  },
];

const TOOL_USE_HISTORY: Message[] = [
  { role: "user", content: [{ type: "text", text: "what's in the log?" }] },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-1",
        name: "bash",
        input: { command: "tail -n 5 server.log" },
      },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu-1",
        content: "line1\nline2\nline3",
      },
    ],
  },
];

const SYSTEM_PROMPT = "You are a helpful assistant with a long preamble.";

const SAMPLE_TOOLS: ToolDefinition[] = [
  {
    name: "bash",
    description: "Execute a shell command and return its output.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "file_read",
    description: "Read a file from the workspace.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────

function registerDefault(): void {
  registerPlugin(defaultTokenEstimatePlugin);
}

function rawEstimate(
  args: Pick<EstimateArgs, "history" | "systemPrompt" | "providerName"> & {
    tools: ToolDefinition[];
  },
): number {
  const toolTokenBudget =
    args.tools.length > 0 ? estimateToolsTokens(args.tools) : 0;
  return estimatePromptTokensRaw(args.history, args.systemPrompt, {
    providerName: args.providerName,
    toolTokenBudget,
  });
}

async function runViaPipeline(args: EstimateArgs): Promise<EstimateResult> {
  return runPipeline<EstimateArgs, EstimateResult>(
    "tokenEstimate",
    getMiddlewaresFor("tokenEstimate"),
    // Terminal is a sentinel — the default plugin's middleware short-circuits
    // so this should only run when no plugin contributes. We make it throw
    // to catch any accidental fall-through.
    async () => {
      throw new Error(
        "pipeline terminal reached — no middleware short-circuit",
      );
    },
    args,
    makeCtx(),
    DEFAULT_TIMEOUTS.tokenEstimate,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetPluginRegistryForTests();
});

afterEach(() => {
  resetPluginRegistryForTests();
});

describe("tokenEstimate pipeline — default plugin parity", () => {
  test("default matches estimatePromptTokensRaw on empty history", async () => {
    registerDefault();
    const args: EstimateArgs = {
      history: EMPTY_HISTORY,
      systemPrompt: undefined,
      tools: [],
      providerName: undefined,
    };
    const pipelineResult = await runViaPipeline(args);
    expect(pipelineResult).toBe(rawEstimate(args));
  });

  test("default matches estimatePromptTokensRaw on text-only history", async () => {
    registerDefault();
    const args: EstimateArgs = {
      history: TEXT_HISTORY,
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      providerName: "anthropic",
    };
    const pipelineResult = await runViaPipeline(args);
    expect(pipelineResult).toBe(rawEstimate(args));
    // Sanity: the system prompt adds real token cost, so the number is
    // strictly larger than the bare-history estimate.
    expect(pipelineResult).toBeGreaterThan(
      rawEstimate({
        history: TEXT_HISTORY,
        systemPrompt: undefined,
        tools: [],
        providerName: "anthropic",
      }),
    );
  });

  test("default matches estimatePromptTokensRaw with tool_use/tool_result blocks", async () => {
    registerDefault();
    const args: EstimateArgs = {
      history: TOOL_USE_HISTORY,
      systemPrompt: SYSTEM_PROMPT,
      tools: SAMPLE_TOOLS,
      providerName: "anthropic",
    };
    const pipelineResult = await runViaPipeline(args);
    expect(pipelineResult).toBe(rawEstimate(args));
  });

  test("default folds tool definition tokens into the result", async () => {
    registerDefault();
    const baseArgs: EstimateArgs = {
      history: TEXT_HISTORY,
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      providerName: "anthropic",
    };
    const withoutTools = await runViaPipeline(baseArgs);
    const withTools = await runViaPipeline({
      ...baseArgs,
      tools: SAMPLE_TOOLS,
    });
    // Tools contribute non-zero overhead; the pipeline result must grow.
    const toolBudget = estimateToolsTokens(SAMPLE_TOOLS);
    expect(toolBudget).toBeGreaterThan(0);
    expect(withTools - withoutTools).toBe(toolBudget);
  });

  test("provider-specific image sizing flows through the default", async () => {
    registerDefault();
    // Two providers see different image token costs for the same content —
    // the raw estimator is the source of truth, so the pipeline must agree
    // under both provider names.
    const imageHistory: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              // Small fake PNG-ish payload; the estimator's fallback path
              // kicks in when parseImageDimensions fails, which is fine —
              // the two providers still diverge on overhead.
              data: "a".repeat(128),
            },
          },
        ],
      },
    ];
    const anthropicArgs: EstimateArgs = {
      history: imageHistory,
      systemPrompt: undefined,
      tools: [],
      providerName: "anthropic",
    };
    const openaiArgs: EstimateArgs = {
      ...anthropicArgs,
      providerName: "openai",
    };
    const anthropicResult = await runViaPipeline(anthropicArgs);
    const openaiResult = await runViaPipeline(openaiArgs);
    expect(anthropicResult).toBe(rawEstimate(anthropicArgs));
    expect(openaiResult).toBe(rawEstimate(openaiArgs));
  });
});

describe("tokenEstimate pipeline — custom override", () => {
  test("custom plugin short-circuit returns a different value than the default", async () => {
    // A plugin that completely replaces the default with a fixed value,
    // proving plugins can substitute provider-native tokenizers (e.g.
    // `countTokens`) without touching orchestrator code.
    const FIXED = 424242;
    const override: Middleware<EstimateArgs, EstimateResult> = async (
      _args,
      _next,
      _ctx,
    ) => FIXED;
    const customPlugin: Plugin = {
      manifest: {
        name: "custom-token-estimate",
        version: "1.0.0",
        requires: { pluginRuntime: "v1", tokenEstimateApi: "v1" },
      },
      middleware: { tokenEstimate: override },
    };

    // Register the custom plugin FIRST so it sits outermost and short-
    // circuits before the default's terminal runs.
    registerPlugin(customPlugin);
    registerDefault();

    const args: EstimateArgs = {
      history: TEXT_HISTORY,
      systemPrompt: SYSTEM_PROMPT,
      tools: SAMPLE_TOOLS,
      providerName: "anthropic",
    };
    const pipelineResult = await runViaPipeline(args);
    expect(pipelineResult).toBe(FIXED);
    // And for contrast: the default alone would have given the raw value.
    expect(pipelineResult).not.toBe(rawEstimate(args));
  });

  test("wrapper middleware that scales the downstream result composes with the default", async () => {
    // A plugin that wraps the downstream estimate, doubling it. This
    // exercises the onion composition: outer middleware sees the raw
    // default result and returns its own modification.
    const doubler: Middleware<EstimateArgs, EstimateResult> = async (
      args,
      next,
      _ctx,
    ) => {
      const inner = await next(args);
      return inner * 2;
    };
    const wrapperPlugin: Plugin = {
      manifest: {
        name: "doubling-token-estimate",
        version: "1.0.0",
        requires: { pluginRuntime: "v1", tokenEstimateApi: "v1" },
      },
      middleware: { tokenEstimate: doubler },
    };

    registerPlugin(wrapperPlugin);
    registerDefault();

    const args: EstimateArgs = {
      history: TEXT_HISTORY,
      systemPrompt: SYSTEM_PROMPT,
      tools: SAMPLE_TOOLS,
      providerName: "anthropic",
    };
    const pipelineResult = await runViaPipeline(args);
    expect(pipelineResult).toBe(rawEstimate(args) * 2);
  });
});

describe("tokenEstimate pipeline — empty registry fallback", () => {
  test("without any plugin registered, the terminal receives the call", async () => {
    // `runViaPipeline` uses a throwing terminal, so here we run the
    // pipeline with an explicit terminal that returns a sentinel to prove
    // that an empty middleware list falls through.
    const SENTINEL = 12345;
    const result = await runPipeline<EstimateArgs, EstimateResult>(
      "tokenEstimate",
      getMiddlewaresFor("tokenEstimate"),
      async () => SENTINEL,
      {
        history: TEXT_HISTORY,
        systemPrompt: SYSTEM_PROMPT,
        tools: [],
        providerName: "anthropic",
      },
      makeCtx(),
      DEFAULT_TIMEOUTS.tokenEstimate,
    );
    expect(result).toBe(SENTINEL);
  });
});
