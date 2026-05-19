import { describe, expect, test } from "bun:test";

import {
  modelSupportsVision,
  resolveProfileParamVisibility,
  VISIBILITY_NONE,
} from "@/domains/settings/ai/profileParamVisibility.js";

describe("resolveProfileParamVisibility", () => {
  test("no provider/model returns VISIBILITY_NONE", () => {
    expect(resolveProfileParamVisibility("", "")).toEqual(VISIBILITY_NONE);
    expect(resolveProfileParamVisibility("", "claude-opus-4-7")).toEqual(VISIBILITY_NONE);
    expect(resolveProfileParamVisibility("anthropic", "")).toEqual(VISIBILITY_NONE);
  });

  test("anthropic + claude-opus-4-7 → all fields visible except verbosity", () => {
    const v = resolveProfileParamVisibility("anthropic", "claude-opus-4-7");
    expect(v.maxTokens).toBe(true);
    expect(v.contextWindow).toBe(true);
    expect(v.effort).toBe(true);
    expect(v.speed).toBe(true);
    expect(v.verbosity).toBe(false);
    expect(v.temperature).toBe(true);
    expect(v.thinking).toBe(true);
  });

  test("anthropic + claude-haiku-4-5-20251001 → effort=false, thinking=true (haiku supports thinking), speed=false", () => {
    const v = resolveProfileParamVisibility("anthropic", "claude-haiku-4-5-20251001");
    expect(v.maxTokens).toBe(true);
    expect(v.contextWindow).toBe(true);
    expect(v.effort).toBe(false);
    expect(v.speed).toBe(false);
    expect(v.verbosity).toBe(false);
    expect(v.temperature).toBe(true);
    expect(v.thinking).toBe(true);
  });

  test("anthropic + claude-sonnet-4-6 → effort=true, speed=false, thinking=true", () => {
    const v = resolveProfileParamVisibility("anthropic", "claude-sonnet-4-6");
    expect(v.maxTokens).toBe(true);
    expect(v.contextWindow).toBe(true);
    expect(v.effort).toBe(true);
    expect(v.speed).toBe(false);
    expect(v.verbosity).toBe(false);
    expect(v.temperature).toBe(true);
    expect(v.thinking).toBe(true);
  });

  test("openai + gpt-5.5 → effort=true, verbosity=true, speed=false, temperature=false, thinking=false", () => {
    const v = resolveProfileParamVisibility("openai", "gpt-5.5");
    expect(v.maxTokens).toBe(true);
    expect(v.contextWindow).toBe(true);
    expect(v.effort).toBe(true);
    expect(v.speed).toBe(false);
    expect(v.verbosity).toBe(true);
    expect(v.temperature).toBe(false);
    expect(v.thinking).toBe(false);
  });

  test("openai + non-gpt-5 model → effort=false, verbosity=false", () => {
    const v = resolveProfileParamVisibility("openai", "gpt-4o");
    expect(v.maxTokens).toBe(true);
    expect(v.contextWindow).toBe(true);
    expect(v.effort).toBe(false);
    expect(v.verbosity).toBe(false);
    expect(v.temperature).toBe(false);
    expect(v.thinking).toBe(false);
  });

  test("gemini provider → maxTokens and contextWindow true, advanced fields false", () => {
    const v = resolveProfileParamVisibility("gemini", "gemini-2.5-flash");
    expect(v.maxTokens).toBe(true);
    expect(v.contextWindow).toBe(true);
    expect(v.effort).toBe(false);
    expect(v.speed).toBe(false);
    expect(v.verbosity).toBe(false);
    expect(v.temperature).toBe(false);
    expect(v.thinking).toBe(false);
  });

  test("isOpenAIGPT5Family matches gpt-5 variants correctly", () => {
    // gpt-5.x family → effort + verbosity
    expect(resolveProfileParamVisibility("openai", "gpt-5.4").effort).toBe(true);
    expect(resolveProfileParamVisibility("openai", "gpt-5.4-mini").effort).toBe(true);
    expect(resolveProfileParamVisibility("openai", "gpt-5-turbo").effort).toBe(true);
    // exact "gpt-5"
    expect(resolveProfileParamVisibility("openai", "gpt-5").effort).toBe(true);
    // non-gpt-5 family
    expect(resolveProfileParamVisibility("openai", "gpt-4o").effort).toBe(false);
  });
});

describe("modelSupportsVision (fallback)", () => {
  test("returns true for every input — the daemon config API is the source of truth", () => {
    // Fallback is intentionally permissive so attachment flows aren't blocked
    // when the daemon hasn't surfaced supportsVision yet. The chat composer
    // uses the daemon-supplied value when present and only consults this
    // helper as a fail-open fallback.
    expect(modelSupportsVision("anthropic", "claude-opus-4-7")).toBe(true);
    expect(modelSupportsVision("fireworks", "accounts/fireworks/models/llama-v4-maverick")).toBe(true);
    expect(modelSupportsVision("unknown-provider", "unknown-model")).toBe(true);
  });
});
