/**
 * Shape-only tests for the plugin core types (PR 11).
 *
 * These tests don't exercise any runtime behavior — they only assert, via
 * the `satisfies` operator, that a fully-populated `Plugin` literal lines
 * up with the public interface. If a later PR changes a field name or
 * signature in a breaking way, this file fails to type-check and the
 * regression is caught at `tsc --noEmit` / `bun test` time.
 */

import { describe, expect, test } from "bun:test";

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import { RiskLevel } from "../permissions/types.js";
import {
  type CircuitBreakerArgs,
  type CircuitBreakerResult,
  type CompactionArgs,
  type CompactionResult,
  type EmptyResponseArgs,
  type EmptyResponseResult,
  type EstimateArgs,
  type EstimateResult,
  type Injector,
  type LLMCallArgs,
  type LLMCallResult,
  type MemoryArgs,
  type MemoryResult,
  type Middleware,
  type OverflowReduceArgs,
  type OverflowReduceResult,
  type PersistArgs,
  type PersistResult,
  type Plugin,
  PluginExecutionError,
  type PluginInitContext,
  type PluginManifest,
  PluginTimeoutError,
  type TitleArgs,
  type TitleResult,
  type ToolErrorArgs,
  type ToolErrorDecision,
  type ToolExecuteArgs,
  type ToolExecuteResult,
  type ToolResultTruncateArgs,
  type ToolResultTruncateResult,
  type TurnContext,
} from "../plugins/types.js";
import type { Tool } from "../tools/types.js";

const sampleTrust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

const sampleTurnContext: TurnContext = {
  requestId: "req-abc",
  conversationId: "conv-xyz",
  turnIndex: 0,
  pluginName: "sample-plugin",
  trust: sampleTrust,
};

describe("plugin core types", () => {
  test("a fully-populated Plugin literal satisfies the interface", () => {
    const manifest: PluginManifest = {
      name: "sample-plugin",
      version: "0.1.0",
      provides: { sampleApi: "v1" },
      requires: { pluginRuntime: "v1" },
      requiresCredential: ["SAMPLE_API_KEY"],
      requiresFlag: ["sample-feature"],
      config: { parse: (input: unknown) => input },
    };

    // Generic passthrough — typed per slot below because per-pipeline
    // arg/result types have diverged from the early `{input: unknown}` /
    // `{output: unknown}` placeholders as individual pipeline wrap-up PRs
    // land.
    function passthroughFor<A, R>(): Middleware<A, R> {
      return async (args, next, _ctx) => next(args);
    }
    const passthrough: Middleware<
      { input: unknown },
      { output: unknown }
    > = async (args, next, _ctx) => next(args);
    const passthroughHistoryRepair = passthroughFor<
      import("../plugins/types.js").HistoryRepairArgs,
      import("../plugins/types.js").HistoryRepairResult
    >();

    // `llmCall` has concrete arg/result types (upgraded in PR 15).
    const llmCallPassthrough: Middleware<LLMCallArgs, LLMCallResult> = async (
      args,
      next,
      _ctx,
    ) => next(args);

    // `toolExecute` has concrete arg/result types (refined in PR 16).
    const toolExecutePassthrough: Middleware<
      ToolExecuteArgs,
      ToolExecuteResult
    > = async (args, next, _ctx) => next(args);

    // `toolResultTruncate` has a concrete args/result shape (PR 17) so we
    // need a dedicated passthrough for that slot.
    const truncatePassthrough: Middleware<
      ToolResultTruncateArgs,
      ToolResultTruncateResult
    > = async (args, _next, _ctx) => ({
      content: args.content,
      truncated: false,
    });

    // The `emptyResponse` slot has concrete args/result types; use a
    // dedicated passthrough so the `satisfies Plugin` check stays honest.
    const emptyResponsePassthrough: Middleware<
      EmptyResponseArgs,
      EmptyResponseResult
    > = async (args, next, _ctx) => next(args);

    // The `toolError` slot has concrete args/result types (PR 19); use a
    // dedicated passthrough so the shape-only test keeps compiling as types
    // get tightened.
    const toolErrorPassthrough: Middleware<
      ToolErrorArgs,
      ToolErrorDecision
    > = async (args, next, _ctx) => next(args);

    // `memoryRetrieval` has a concrete typed signature (MemoryArgs →
    // MemoryResult) introduced in PR 20, so it can't use the generic
    // `{ input }` passthrough above.
    const memoryPassthrough: Middleware<MemoryArgs, MemoryResult> = async (
      args,
      next,
      _ctx,
    ) => next(args);

    // `tokenEstimate` has a concrete arg/result shape (refined in the
    // tokenEstimate-pipeline PR), so its middleware can't share the generic
    // `{ input, output }` passthrough. A slot-specific passthrough keeps the
    // shape-only assertion honest across type-refinement PRs.
    const tokenEstimatePassthrough: Middleware<
      EstimateArgs,
      EstimateResult
    > = async (args, next, _ctx) => next(args);

    // `overflowReduce` has a concrete arg/result shape (PR 23). Uses a
    // dedicated passthrough that returns a structurally-correct result so
    // `satisfies Plugin` keeps verifying the signature.
    const overflowReducePassthrough: Middleware<
      OverflowReduceArgs,
      OverflowReduceResult
    > = async (args, _next, _ctx) => ({
      messages: args.messages,
      runMessages: args.runMessages,
      injectionMode: "full",
      reducerState: {
        appliedTiers: [],
        injectionMode: "full",
        exhausted: true,
      },
      reducerCompacted: false,
      attempts: 0,
    });

    // Slot-specific passthrough for the `compaction` pipeline — PR 25
    // narrowed its args/result away from the generic `{ input: unknown }`
    // placeholder, so the generic `passthrough` no longer satisfies its
    // middleware signature. This dedicated middleware keeps the shape-only
    // assertion for the slot without forcing every other slot to narrow.
    const compactionPassthrough: Middleware<
      CompactionArgs,
      CompactionResult
    > = async (args, next, _ctx) => next(args);

    // `circuitBreaker` carries a concrete arg shape (pipeline wrapping
    // landed ahead of the other slots) so it needs its own passthrough
    // rather than reusing the generic placeholder.
    const circuitPassthrough: Middleware<
      CircuitBreakerArgs,
      CircuitBreakerResult
    > = async (args, next, _ctx) => next(args);

    // `persistence` has concrete discriminated-union arg/result types
    // (upgraded from the initial `{ input }/{ output }` placeholder in PR 27)
    // so it gets its own passthrough rather than sharing the generic one
    // above.
    const persistPassthrough: Middleware<PersistArgs, PersistResult> = async (
      args,
      next,
      _ctx,
    ) => next(args);

    // The `titleGenerate` slot now has concrete arg/result types (PR 28)
    // rather than the placeholder `{ input/output: unknown }` shape, so it
    // needs its own passthrough implementation.
    const titlePassthrough: Middleware<TitleArgs, TitleResult> = async (
      args,
      next,
      _ctx,
    ) => next(args);

    const injector: Injector = {
      name: "sample-injector",
      order: 10,
      async produce(_ctx) {
        return { id: "sample-block", text: "hello", meta: { kind: "demo" } };
      },
    };

    const sampleTool: Tool = {
      name: "sample-tool",
      description: "Sample plugin tool",
      category: "plugins",
      defaultRiskLevel: RiskLevel.Low,
      getDefinition() {
        return {
          name: "sample-tool",
          description: "Sample plugin tool",
          input_schema: { type: "object", properties: {}, required: [] },
        };
      },
      async execute() {
        return { content: "ok", isError: false };
      },
    };

    const plugin = {
      manifest,
      async init(ctx: PluginInitContext) {
        // Touch every field so refactors that rename any of them break here.
        void ctx.config;
        void ctx.credentials;
        void ctx.logger;
        void ctx.pluginStorageDir;
        void ctx.assistantVersion;
        void ctx.apiVersions;
      },
      async onShutdown() {
        // no-op
      },
      tools: [sampleTool],
      routes: [
        {
          pattern: /^\/sample$/,
          methods: ["GET"],
          handler: async () => new Response("ok", { status: 200 }),
        },
      ],
      skills: [
        {
          id: "sample-skill",
          name: "Sample Skill",
          description: "Demo plugin-contributed skill",
          body: "## Sample\n\nPlugin-provided skill body.",
        },
      ],
      injectors: [injector],
      middleware: {
        turn: passthrough,
        llmCall: llmCallPassthrough,
        toolExecute: toolExecutePassthrough,
        memoryRetrieval: memoryPassthrough,
        historyRepair: passthroughHistoryRepair,
        tokenEstimate: tokenEstimatePassthrough,
        compaction: compactionPassthrough,
        overflowReduce: overflowReducePassthrough,
        persistence: persistPassthrough,
        titleGenerate: titlePassthrough,
        toolResultTruncate: truncatePassthrough,
        emptyResponse: emptyResponsePassthrough,
        toolError: toolErrorPassthrough,
        circuitBreaker: circuitPassthrough,
      },
    } satisfies Plugin;

    // Minimal runtime check so the test body is non-empty.
    expect(plugin.manifest.name).toBe("sample-plugin");
    expect(plugin.middleware.turn).toBe(passthrough);
    expect(plugin.middleware.historyRepair).toBe(passthroughHistoryRepair);
  });

  test("PluginTimeoutError carries pipeline, plugin, and elapsed fields", () => {
    const err = new PluginTimeoutError("compaction", "sample-plugin", 30000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PluginTimeoutError");
    expect(err.pipeline).toBe("compaction");
    expect(err.pluginName).toBe("sample-plugin");
    expect(err.elapsedMs).toBe(30000);
    expect(err.message).toContain("compaction");
    expect(err.message).toContain("30000");
    expect(err.message).toContain("sample-plugin");
  });

  test("PluginTimeoutError omits plugin suffix when unknown", () => {
    const err = new PluginTimeoutError("llmCall", undefined, 1234);
    expect(err.pluginName).toBeUndefined();
    expect(err.message).not.toContain("offending plugin");
  });

  test("PluginExecutionError carries the plugin name and message", () => {
    const err = new PluginExecutionError(
      "plugin 'x' requires memoryApi@v2, assistant exposes v1",
      "x",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PluginExecutionError");
    expect(err.pluginName).toBe("x");
    expect(err.message).toContain("memoryApi@v2");
  });

  test("TurnContext references the canonical TrustContext", () => {
    // Assignment is the real assertion — if `TurnContext.trust` drifts from
    // `TrustContext` this fails to compile.
    const ctx: TurnContext = sampleTurnContext;
    expect(ctx.trust.trustClass).toBe("guardian");
    expect(ctx.trust.sourceChannel).toBe("vellum");
  });
});
