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

import type { TrustContext } from "../daemon/trust-context-types.js";
import { RiskLevel } from "../permissions/types.js";
import {
  type InitContext,
  type Plugin,
  PluginExecutionError,
  type PluginManifest,
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
  trust: sampleTrust,
};

describe("plugin core types", () => {
  test("a fully-populated Plugin literal satisfies the interface", () => {
    const manifest: PluginManifest = {
      name: "sample-plugin",
      version: "0.1.0",
      config: { parse: (input: unknown) => input },
    };

    const sampleTool: Tool = {
      name: "sample-tool",
      description: "Sample plugin tool",
      defaultRiskLevel: RiskLevel.Low,
      executionTarget: "sandbox",
      input_schema: { type: "object", properties: {}, required: [] },
      category: "",
      async execute() {
        return { content: "ok", isError: false };
      },
    };

    const plugin = {
      manifest,
      hooks: {
        async init(ctx: InitContext) {
          // Touch every field so refactors that rename any of them break here.
          void ctx.config;
          void ctx.logger;
          void ctx.pluginStorageDir;
          void ctx.assistantVersion;
        },
        async shutdown() {
          // no-op
        },
      },
      tools: [sampleTool],
      routes: [
        {
          pattern: /^\/sample$/,
          methods: ["GET"],
          handler: async () => new Response("ok", { status: 200 }),
        },
      ],
    } satisfies Plugin;

    // Minimal runtime check so the test body is non-empty.
    expect(plugin.manifest.name).toBe("sample-plugin");
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
