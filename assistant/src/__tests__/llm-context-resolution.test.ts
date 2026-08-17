import { describe, expect, mock, test } from "bun:test";

// Entry-name providers resolve context limits through their row's kind, so
// the tests control the row store directly. A dangling label (no row) falls
// back to the model's catalog owner.
const connectionRows = new Map<string, { name: string; provider: string }>([
  ["openai-work", { name: "openai-work", provider: "openai" }],
  ["my-endpoint", { name: "my-endpoint", provider: "openai-compatible" }],
]);
mock.module("../persistence/db-connection.js", () => ({
  getDb: () => ({}),
}));
mock.module("../providers/inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) =>
    connectionRows.get(name) ?? null,
  listConnections: () => [],
  canonicalVellumConnection: () => null,
}));

import { resolveEffectiveContextWindow } from "../config/llm-context-resolution.js";
import { LLMSchema } from "../config/schemas/llm.js";

describe("resolveEffectiveContextWindow", () => {
  test("call-site config without context override resolves to 200k", () => {
    const llm = LLMSchema.parse({
      callSites: {
        mainAgent: {
          provider: "openai",
          model: "gpt-5.5",
        },
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

  test("active profile context override beats the code-default window", () => {
    const llm = LLMSchema.parse({
      profiles: {
        long: {
          provider: "openai",
          model: "gpt-5.5",
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

  test("main agent active profile context override beats call-site profile defaults", () => {
    const llm = LLMSchema.parse({
      profiles: {
        active: {
          provider: "openai",
          model: "gpt-5.5",
          contextWindow: { maxInputTokens: 150000 },
        },
        site: {
          label: "Site profile",
          description: "Used by one call site.",
          source: "user",
          provider: "openai",
          model: "gpt-5.5",
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

    expect(resolved.maxInputTokens).toBe(150000);
    expect(resolved.compactThreshold).toBe(0.8);
    expect(resolved.summaryBudgetRatio).toBe(0.05);
    expect(resolved.targetBudgetRatio).toBe(0.3);
    expect(resolved.overflowRecovery.maxAttempts).toBe(3);
  });

  test("non-main call-site profile context override beats active profile", () => {
    const llm = LLMSchema.parse({
      profiles: {
        active: {
          provider: "openai",
          model: "gpt-5.5",
          contextWindow: { maxInputTokens: 150000 },
        },
        site: {
          provider: "openai",
          model: "gpt-5.5",
          contextWindow: { maxInputTokens: 175000 },
        },
      },
      activeProfile: "active",
      callSites: {
        memoryExtraction: { profile: "site" },
      },
    });

    const resolved = resolveEffectiveContextWindow({
      llm,
      callSite: "memoryExtraction",
    });

    expect(resolved.maxInputTokens).toBe(175000);
  });

  test("a routing-identity profile resolves the model's own context limits", () => {
    const llm = LLMSchema.parse({
      profiles: {
        managed: { provider: "vellum", model: "gpt-5.5" },
      },
      activeProfile: "managed",
    });

    const resolved = resolveEffectiveContextWindow({
      llm,
      callSite: "mainAgent",
    });

    // The catalog owner (openai) carries gpt-5.5's limits; a raw "vellum"
    // lookup would miss and misreport the model max as the 200k default.
    expect(resolved.modelMaxInputTokens).toBe(1050000);
  });

  test("an entry of a catalog kind resolves the model's own context limits", () => {
    // The entries collapse stores connection names in the provider field;
    // the row's kind carries the model's limits, so an entry label must not
    // fall back to the 200k default when its kind serves the model.
    const llm = LLMSchema.parse({
      profiles: {
        work: { provider: "openai-work", model: "gpt-5.5" },
      },
      activeProfile: "work",
    });

    const resolved = resolveEffectiveContextWindow({
      llm,
      callSite: "mainAgent",
    });

    expect(resolved.modelMaxInputTokens).toBe(1050000);
    expect(resolved.maxOutputTokens).toBeDefined();
  });

  test("a custom-endpoint entry keeps the conservative default for a catalog-colliding model id", () => {
    // An openai-compatible endpoint's "gpt-5.5" is not OpenAI's; inheriting
    // the built-in 1.05M limit would let oversized requests through.
    const llm = LLMSchema.parse({
      profiles: {
        custom: { provider: "my-endpoint", model: "gpt-5.5" },
      },
      activeProfile: "custom",
    });

    const resolved = resolveEffectiveContextWindow({
      llm,
      callSite: "mainAgent",
    });

    expect(resolved.modelMaxInputTokens).toBe(200000);
    expect(resolved.maxOutputTokens).toBeUndefined();
  });

  test("a label with no row falls back to the model's catalog owner", () => {
    const llm = LLMSchema.parse({
      profiles: {
        gone: { provider: "deleted-entry", model: "gpt-5.5" },
      },
      activeProfile: "gone",
    });

    const resolved = resolveEffectiveContextWindow({
      llm,
      callSite: "mainAgent",
    });

    expect(resolved.modelMaxInputTokens).toBe(1050000);
  });

  test("unknown catalog model falls back safely to the default 200k cap", () => {
    const llm = LLMSchema.parse({
      callSites: {
        mainAgent: {
          provider: "openai",
          model: "custom-model",
          contextWindow: { maxInputTokens: 300000 },
        },
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
      callSites: {
        mainAgent: {
          provider: "openai",
          model: "gpt-5.5",
          contextWindow: { maxInputTokens: 2000000 },
        },
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
      profiles: {
        capped: {
          provider: "openai",
          model: "gpt-5.5",
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
