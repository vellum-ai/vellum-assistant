import { describe, expect, test } from "bun:test";

import {
  geminiThinkingLevels,
  modelSupportsThinking,
  resolveProfileParamVisibility,
  VISIBILITY_NONE,
} from "@/domains/settings/ai/profile-param-visibility";

describe("resolveProfileParamVisibility", () => {
  test("returns all-false for empty provider or model", () => {
    expect(resolveProfileParamVisibility("", "")).toEqual(VISIBILITY_NONE);
    expect(resolveProfileParamVisibility("anthropic", "")).toEqual(VISIBILITY_NONE);
    expect(resolveProfileParamVisibility("", "claude-sonnet-4-20250514")).toEqual(VISIBILITY_NONE);
  });

  test("anthropic non-haiku enables maxTokens, contextWindow, effort, temperature, thinking", () => {
    const vis = resolveProfileParamVisibility("anthropic", "claude-sonnet-4-20250514");
    expect(vis.maxTokens).toBe(true);
    expect(vis.contextWindow).toBe(true);
    expect(vis.effort).toBe(true);
    expect(vis.temperature).toBe(true);
    expect(vis.topP).toBe(true);
    expect(vis.thinking).toBe(true);
    expect(vis.thinkingLevel).toBe(false);
    expect(vis.verbosity).toBe(false);
  });

  test("topP is true for anthropic, fireworks, openrouter, and openai-compatible, false for gemini", () => {
    expect(resolveProfileParamVisibility("anthropic", "claude-3-opus-20240229").topP).toBe(true);
    expect(
      resolveProfileParamVisibility("fireworks", "accounts/fireworks/models/minimax-m3").topP,
    ).toBe(true);
    expect(resolveProfileParamVisibility("openrouter", "anthropic/claude-fable-5").topP).toBe(true);
    expect(resolveProfileParamVisibility("together", "MiniMaxAI/MiniMax-M3").topP).toBe(true);
    // Custom OpenAI-compatible connections route through the OpenAI adapter,
    // which forwards top_p — so the control must be visible for them too.
    expect(resolveProfileParamVisibility("openai-compatible", "some-custom-model").topP).toBe(true);
    // Native `openai` uses the Responses API, which doesn't forward sampling
    // params — topP is hidden there (same as temperature).
    expect(resolveProfileParamVisibility("openai", "gpt-5").topP).toBe(false);
    expect(resolveProfileParamVisibility("openai", "gpt-4o").topP).toBe(false);
    expect(resolveProfileParamVisibility("gemini", "gemini-2.5-flash").topP).toBe(false);
    expect(VISIBILITY_NONE.topP).toBe(false);
  });

  test("anthropic haiku disables effort but supports thinking", () => {
    const vis = resolveProfileParamVisibility("anthropic", "claude-3-5-haiku-20241022");
    expect(vis.effort).toBe(false);
    // Haiku supports thinking (per catalog) but not effort (haiku-specific gate)
    expect(vis.thinking).toBe(true);
  });

  test("anthropic fable hides the thinking toggle but keeps effort", () => {
    const vis = resolveProfileParamVisibility("anthropic", "claude-fable-5");
    // Fable reasons with always-on adaptive thinking: effort stays adjustable,
    // but the enable/disable toggle is hidden so the UI never emits a
    // `thinking: { type: "disabled" }` request (which Fable would 400).
    expect(vis.effort).toBe(true);
    expect(vis.thinking).toBe(false);
    expect(vis.temperature).toBe(true);
  });

  test("openrouter anthropic fable hides the thinking toggle but keeps effort", () => {
    const vis = resolveProfileParamVisibility("openrouter", "anthropic/claude-fable-5");
    expect(vis.effort).toBe(true);
    expect(vis.thinking).toBe(false);
  });

  test("vercel-ai-gateway anthropic sonnet/opus enable thinking and effort", () => {
    for (const model of ["anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.8"]) {
      const vis = resolveProfileParamVisibility("vercel-ai-gateway", model);
      expect(vis.thinking).toBe(true);
      expect(vis.effort).toBe(true);
    }
  });

  test("vercel-ai-gateway anthropic haiku supports thinking but not effort", () => {
    const vis = resolveProfileParamVisibility("vercel-ai-gateway", "anthropic/claude-haiku-4.5");
    expect(vis.thinking).toBe(true);
    expect(vis.effort).toBe(false);
  });

  test("vercel-ai-gateway anthropic fable hides the thinking toggle but keeps effort", () => {
    const vis = resolveProfileParamVisibility("vercel-ai-gateway", "anthropic/claude-fable-5");
    expect(vis.effort).toBe(true);
    expect(vis.thinking).toBe(false);
  });

  test("vercel-ai-gateway non-anthropic catalog reasoning model gets thinking with effort following", () => {
    // xai/grok-4.3 is supportsThinking in the catalog; effort follows thinking
    // for non-anthropic gateway models (same rule as openrouter).
    const vis = resolveProfileParamVisibility("vercel-ai-gateway", "xai/grok-4.3");
    expect(vis.thinking).toBe(true);
    expect(vis.effort).toBe(true);
  });

  test("vercel-ai-gateway unknown non-anthropic model gets no thinking or effort", () => {
    const vis = resolveProfileParamVisibility("vercel-ai-gateway", "mistral/mistral-large");
    expect(vis.thinking).toBe(false);
    expect(vis.effort).toBe(false);
  });

  test("together MiniMax M3 enables effort and topP", () => {
    const vis = resolveProfileParamVisibility("together", "MiniMaxAI/MiniMax-M3");
    // Together is an OpenAI-compatible endpoint whose chat-completions client
    // forwards both top_p and reasoning_effort; MiniMax M3 is a reasoning model
    // (supportsThinking in the catalog), so effort is adjustable too.
    expect(vis.effort).toBe(true);
    expect(vis.topP).toBe(true);
    // Temperature stays Anthropic-wire only; Together doesn't get it.
    expect(vis.temperature).toBe(false);
  });

  test("anthropic opus enables speed", () => {
    const vis = resolveProfileParamVisibility("anthropic", "claude-3-opus-20240229");
    expect(vis.speed).toBe(true);
  });

  test("openai gpt-5 enables effort and verbosity", () => {
    const vis = resolveProfileParamVisibility("openai", "gpt-5");
    expect(vis.effort).toBe(true);
    expect(vis.verbosity).toBe(true);
    expect(vis.thinking).toBe(false);
    expect(vis.thinkingLevel).toBe(false);
  });

  test("gemini enables thinkingLevel for thinking-capable models", () => {
    const vis = resolveProfileParamVisibility("gemini", "gemini-2.5-flash");
    expect(vis.thinkingLevel).toBe(true);
    expect(vis.thinking).toBe(false);
  });

  test("ollama gets maxTokens, contextWindow, and topP", () => {
    const vis = resolveProfileParamVisibility("ollama", "llama3");
    expect(vis.maxTokens).toBe(true);
    expect(vis.contextWindow).toBe(true);
    // ollama is OpenAI-compatible, so it forwards top_p
    expect(vis.topP).toBe(true);
    expect(vis.effort).toBe(false);
    expect(vis.speed).toBe(false);
    expect(vis.verbosity).toBe(false);
    expect(vis.temperature).toBe(false);
    expect(vis.thinking).toBe(false);
    expect(vis.thinkingLevel).toBe(false);
  });
});

describe("modelSupportsThinking", () => {
  test("matches mixed-case catalog ids case-insensitively (minimax)", () => {
    // The web catalog stores minimax ids mixed-case ("MiniMax-M3") while
    // resolveProfileParamVisibility lowercases the model id before the
    // catalog lookup, so the exact-id find must be case-insensitive or the
    // minimax entries are unreachable.
    expect(modelSupportsThinking("minimax", "minimax-m3")).toBe(true);
    expect(modelSupportsThinking("minimax", "MiniMax-M2.7")).toBe(true);
    expect(modelSupportsThinking("minimax", "minimax-unknown")).toBe(false);
  });

  test("vercel-ai-gateway falls back to the anthropic/ prefix heuristic off-catalog", () => {
    expect(modelSupportsThinking("vercel-ai-gateway", "anthropic/claude-next")).toBe(true);
    expect(modelSupportsThinking("vercel-ai-gateway", "mistral/mistral-large")).toBe(false);
  });
});

describe("geminiThinkingLevels", () => {
  test("pro models exclude 'minimal'", () => {
    const levels = geminiThinkingLevels("gemini-3.0-pro");
    expect(levels).toEqual(["low", "medium", "high"]);
    expect(levels).not.toContain("minimal");
  });

  test("non-pro models include 'minimal'", () => {
    const levels = geminiThinkingLevels("gemini-2.5-flash");
    expect(levels).toEqual(["minimal", "low", "medium", "high"]);
  });
});
