import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { PluginHookFn, PreModelCallContext } from "@vellumai/plugin-api";

import {
  isWeakOpenModel,
  WEAK_OPEN_MODEL_PATTERN,
} from "../providers/weak-open-model.js";

// Drive the gate by varying the model the resolver returns. mock.module is not
// hoisted above the static import graph, so the hook is pulled in dynamically
// (in beforeAll) after these mocks register.
let resolvedModel = "claude-sonnet-4-6";

mock.module("../config/loader.js", () => ({
  getConfigReadOnly: () => ({ llm: {} }),
}));
mock.module("../config/llm-resolver.js", () => ({
  resolveCallSiteConfig: () => ({ model: resolvedModel }),
}));

let preModelCall: PluginHookFn<PreModelCallContext>;
let INITIATIVE_COACHING_TEXT: string;

beforeAll(async () => {
  const mod =
    await import("../plugins/defaults/agentic-initiative/hooks/pre-model-call.js");
  preModelCall = mod.default;
  INITIATIVE_COACHING_TEXT = mod.INITIATIVE_COACHING_TEXT;
});

const BASE_PROMPT = "# System\n\nYou are a helpful assistant.";

function makeCtx(
  overrides: Partial<PreModelCallContext> = {},
): PreModelCallContext {
  return {
    conversationId: "conv-1",
    callSite: "mainAgent",
    systemPrompt: BASE_PROMPT,
    deferAssistantOutput: false,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    ...overrides,
  } as PreModelCallContext;
}

describe("isWeakOpenModel", () => {
  test("matches the shipped weak open models across provider spellings", () => {
    for (const model of [
      "accounts/fireworks/models/minimax-m3",
      "minimax/minimax-m3",
      "accounts/fireworks/models/kimi-k2p6",
      "moonshotai/kimi-k2.6",
    ]) {
      expect(isWeakOpenModel(model)).toBe(true);
    }
  });

  test("does not match managed Claude models or adjacent open models", () => {
    for (const model of [
      "claude-sonnet-4-6",
      "claude-opus-4-8",
      "claude-fable-5",
      "accounts/fireworks/models/kimi-k2p5",
      "accounts/fireworks/models/minimax-m2p7",
    ]) {
      expect(isWeakOpenModel(model)).toBe(false);
    }
    // The exported pattern is the single source the exploration-drift loop
    // trigger also gates on.
    expect(WEAK_OPEN_MODEL_PATTERN.test("claude-sonnet-4-6")).toBe(false);
  });
});

describe("agentic-initiative pre-model-call hook", () => {
  beforeEach(() => {
    resolvedModel = "claude-sonnet-4-6";
  });

  test("appends coaching for the user-facing reply on a weak open model", async () => {
    resolvedModel = "accounts/fireworks/models/minimax-m3";
    const ctx = makeCtx();
    await preModelCall(ctx);
    expect(ctx.systemPrompt).toContain(BASE_PROMPT);
    expect(ctx.systemPrompt).toContain(INITIATIVE_COACHING_TEXT);
  });

  test("leaves the prompt untouched on managed Claude models", async () => {
    resolvedModel = "claude-sonnet-4-6";
    const ctx = makeCtx();
    await preModelCall(ctx);
    expect(ctx.systemPrompt).toBe(BASE_PROMPT);
  });

  test("does not coach non-mainAgent call sites even on a weak model", async () => {
    resolvedModel = "accounts/fireworks/models/minimax-m3";
    const ctx = makeCtx({ callSite: "subagentSpawn" });
    await preModelCall(ctx);
    expect(ctx.systemPrompt).toBe(BASE_PROMPT);
  });

  test("no-ops when there is no system prompt to append to", async () => {
    resolvedModel = "accounts/fireworks/models/minimax-m3";
    const ctx = makeCtx({ systemPrompt: null });
    await preModelCall(ctx);
    expect(ctx.systemPrompt).toBeNull();
  });

  test("is idempotent — a re-entrant call does not stack the block", async () => {
    resolvedModel = "accounts/fireworks/models/minimax-m3";
    const ctx = makeCtx();
    await preModelCall(ctx);
    const afterFirst = ctx.systemPrompt;
    await preModelCall(ctx);
    expect(ctx.systemPrompt).toBe(afterFirst);
    const occurrences =
      ctx.systemPrompt!.split(INITIATIVE_COACHING_TEXT).length - 1;
    expect(occurrences).toBe(1);
  });
});
