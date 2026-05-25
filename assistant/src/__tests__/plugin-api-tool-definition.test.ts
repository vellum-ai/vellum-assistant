/**
 * Shape tests for the public `ToolDefinition` author-facing tool spec.
 *
 * These tests don't exercise runtime behavior — they assert via
 * `satisfies` that representative tool literals line up with the public
 * interface. If a later PR breaks a field name or signature in
 * `assistant/src/plugin-api/types.ts`, this file fails to type-check and
 * the regression is caught at `tsc --noEmit` / `bun test` time.
 */

import { describe, expect, test } from "bun:test";

import {
  RiskLevel,
  type ToolContext,
  type ToolDefinition,
  type ToolExecutionResult,
} from "../plugin-api/index.js";

describe("ToolDefinition (public author-facing tool spec) ", () => {
  test("a fully-populated literal satisfies the interface", () => {
    const tool = {
      description: "Greet the model in a fixed language.",
      defaultRiskLevel: RiskLevel.Low,
      input_schema: {
        type: "object",
        properties: {
          language: { type: "string" },
        },
        required: ["language"],
        additionalProperties: false,
      },
      async execute(
        input: Record<string, unknown>,
        _ctx: ToolContext,
      ): Promise<ToolExecutionResult> {
        return {
          content: `hello, ${String(input.language)} speaker`,
          isError: false,
        };
      },
    } as const satisfies ToolDefinition;

    // `as const` propagates literal types and verifies type compatibility,
    // but the runtime expectations below also smoke-check the structure
    // for anyone reading the test without TS folded in.
    expect(typeof tool.execute).toBe("function");
    expect(tool.defaultRiskLevel).toBe(RiskLevel.Low);
  });

  test("every field is optional — empty literal satisfies the interface", () => {
    const tool: ToolDefinition = {};
    expect(tool).toEqual({});
  });

  test("every author-facing risk level is permitted", () => {
    const low: ToolDefinition = { defaultRiskLevel: RiskLevel.Low };
    const medium: ToolDefinition = { defaultRiskLevel: RiskLevel.Medium };
    const high: ToolDefinition = { defaultRiskLevel: RiskLevel.High };

    expect(low.defaultRiskLevel).toBe(RiskLevel.Low);
    expect(medium.defaultRiskLevel).toBe(RiskLevel.Medium);
    expect(high.defaultRiskLevel).toBe(RiskLevel.High);
  });

  test("execute receives the public ToolContext", async () => {
    // Type-only assertion: the execute signature uses the public
    // ToolContext (narrow base). A daemon-internal field added to the
    // rich ToolContext that doesn't exist on the narrow one must not be
    // accessible here. We can't test this at runtime — the assertion
    // lives in `tsc --noEmit` over this file.
    const tool: ToolDefinition = {
      async execute(_input, ctx) {
        // `ctx` is the public `ToolContext`. Touch
        // commonly-needed fields to make sure they're present.
        const _conversationId = ctx.conversationId;
        const _workingDir = ctx.workingDir;
        const _signal = ctx.signal;
        return { content: "ok", isError: false };
      },
    };
    const result = await tool.execute?.(
      {},
      {
        conversationId: "conv-abc",
        workingDir: "/tmp",
        signal: new AbortController().signal,
      } as ToolContext,
    );
    expect(result?.isError).toBe(false);
  });
});
