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
import {
  type Injector,
  type Middleware,
  type Plugin,
  PluginExecutionError,
  type PluginInitContext,
  type PluginManifest,
  PluginTimeoutError,
  type TurnContext,
} from "../plugins/types.js";

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
    const passthroughPlaceholder = passthroughFor<
      { input: unknown },
      { output: unknown }
    >();
    const passthroughHistoryRepair = passthroughFor<
      import("../plugins/types.js").HistoryRepairArgs,
      import("../plugins/types.js").HistoryRepairResult
    >();

    const injector: Injector = {
      name: "sample-injector",
      order: 10,
      async produce(_ctx) {
        return { id: "sample-block", text: "hello", meta: { kind: "demo" } };
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
      tools: [{ name: "sample-tool" }],
      routes: [{ path: "/sample" }],
      skills: [{ name: "sample-skill" }],
      injectors: [injector],
      middleware: {
        turn: passthroughPlaceholder,
        llmCall: passthroughPlaceholder,
        toolExecute: passthroughPlaceholder,
        memoryRetrieval: passthroughPlaceholder,
        historyRepair: passthroughHistoryRepair,
        tokenEstimate: passthroughPlaceholder,
        compaction: passthroughPlaceholder,
        overflowReduce: passthroughPlaceholder,
        persistence: passthroughPlaceholder,
        titleGenerate: passthroughPlaceholder,
        toolResultTruncate: passthroughPlaceholder,
        emptyResponse: passthroughPlaceholder,
        toolError: passthroughPlaceholder,
        circuitBreaker: passthroughPlaceholder,
      },
    } satisfies Plugin;

    // Minimal runtime check so the test body is non-empty.
    expect(plugin.manifest.name).toBe("sample-plugin");
    expect(plugin.middleware.turn).toBe(passthroughPlaceholder);
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
