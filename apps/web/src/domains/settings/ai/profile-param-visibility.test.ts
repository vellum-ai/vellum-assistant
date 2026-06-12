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
    expect(vis.thinking).toBe(true);
    expect(vis.thinkingLevel).toBe(false);
    expect(vis.verbosity).toBe(false);
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

  test("ollama gets only maxTokens and contextWindow", () => {
    const vis = resolveProfileParamVisibility("ollama", "llama3");
    expect(vis.maxTokens).toBe(true);
    expect(vis.contextWindow).toBe(true);
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
