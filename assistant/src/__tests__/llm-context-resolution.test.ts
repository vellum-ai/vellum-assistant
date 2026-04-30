import { describe, expect, test } from "bun:test";

import { resolveEffectiveContextWindow } from "../config/llm-context-resolution.js";
import { LLMSchema } from "../config/schemas/llm.js";

describe("resolveEffectiveContextWindow", () => {
  test("existing config without context override resolves to 200k", () => {
    const llm = LLMSchema.parse({
      default: {
        provider: "openai",
        model: "gpt-5.5",
      },
    });

    const resolved = resolveEffectiveContextWindow({
      llm,
      callSite: "mainAgent",
    });

    expect(resolved.maxInputTokens).toBe(200000);
    expect(resolved.modelMaxInputTokens).toBe(1050000);
    expect(resolved.defaultInputTokens).toBe(200000);
    expect(resolved.isLongContextEnabled).toBe(false);
  });

  test("active profile context override beats llm.default", () => {
    const llm = LLMSchema.parse({
      default: {
        provider: "openai",
        model: "gpt-5.5",
        contextWindow: { maxInputTokens: 100000 },
      },
      profiles: {
        long: {
          contextWindow: { maxInputTokens: 150000 },
        },
      },
      activeProfile: "long",
    });

    const resolved = resolveEffectiveContextWindow({
      llm,
      callSite: "mainAgent",
    });

    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-5.5");
    expect(resolved.maxInputTokens).toBe(150000);
    expect(resolved.modelMaxInputTokens).toBe(1050000);
    expect(resolved.defaultInputTokens).toBe(200000);
    expect(resolved.isLongContextEnabled).toBe(false);
  });

  test("call-site profile context override beats active profile", () => {
    const llm = LLMSchema.parse({
      default: {
        provider: "openai",
        model: "gpt-5.5",
      },
      profiles: {
        active: {
          contextWindow: { maxInputTokens: 150000 },
        },
        site: {
          label: "Site profile",
          description: "Used by one call site.",
          source: "user",
          contextWindow: { maxInputTokens: 175000 },
        },
      },
      activeProfile: "active",
      callSites: {
        mainAgent: { profile: "site" },
      },
    });

    const resolved = resolveEffectiveContextWindow({
      llm,
      callSite: "mainAgent",
    });

    expect(resolved.maxInputTokens).toBe(175000);
    expect(resolved.compactThreshold).toBe(0.8);
    expect(resolved.summaryBudgetRatio).toBe(0.05);
    expect(resolved.targetBudgetRatio).toBe(0.3);
    expect(resolved.overflowRecovery.maxAttempts).toBe(3);
  });

  test("unknown catalog model falls back safely to the default 200k cap", () => {
    const llm = LLMSchema.parse({
      default: {
        provider: "openai",
        model: "custom-model",
        contextWindow: { maxInputTokens: 300000 },
      },
    });

    const resolved = resolveEffectiveContextWindow({
      llm,
      callSite: "mainAgent",
    });

    expect(resolved.maxInputTokens).toBe(200000);
    expect(resolved.modelMaxInputTokens).toBe(200000);
    expect(resolved.defaultInputTokens).toBe(200000);
    expect(resolved.maxOutputTokens).toBeUndefined();
    expect(resolved.isLongContextEnabled).toBe(false);
  });

  test("configured context above the model maximum is clamped", () => {
    const llm = LLMSchema.parse({
      default: {
        provider: "openai",
        model: "gpt-5.5",
        contextWindow: { maxInputTokens: 2000000 },
      },
    });

    const resolved = resolveEffectiveContextWindow({
      llm,
      callSite: "mainAgent",
    });

    expect(resolved.maxInputTokens).toBe(1050000);
    expect(resolved.modelMaxInputTokens).toBe(1050000);
    expect(resolved.isLongContextEnabled).toBe(true);
  });

  test("max output metadata is independent from context budget", () => {
    const llm = LLMSchema.parse({
      default: {
        provider: "openai",
        model: "gpt-5.5",
      },
      profiles: {
        capped: {
          contextWindow: { maxInputTokens: 150000 },
        },
      },
      activeProfile: "capped",
    });

    const resolved = resolveEffectiveContextWindow({
      llm,
      callSite: "mainAgent",
    });

    expect(resolved.maxInputTokens).toBe(150000);
    expect(resolved.modelMaxInputTokens).toBe(1050000);
    expect(resolved.maxOutputTokens).toBe(128000);
  });
});
