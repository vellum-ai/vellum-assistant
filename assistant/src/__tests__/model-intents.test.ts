import { describe, expect, test } from "bun:test";

import {
  getProviderDefaultModel,
  isModelIntent,
  resolveModelIntent,
} from "../providers/model-intents.js";

describe("model intents", () => {
  test("validates model intent strings", () => {
    expect(isModelIntent("latency-optimized")).toBe(true);
    expect(isModelIntent("quality-optimized")).toBe(true);
    expect(isModelIntent("vision-optimized")).toBe(true);
    expect(isModelIntent("fastest-model")).toBe(false);
    expect(isModelIntent(undefined)).toBe(false);
  });

  test("resolves intent to provider-specific model", () => {
    expect(resolveModelIntent("anthropic", "latency-optimized")).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(resolveModelIntent("anthropic", "quality-optimized")).toBe(
      "claude-opus-4-7",
    );
    expect(resolveModelIntent("anthropic", "vision-optimized")).toBe(
      "claude-opus-4-6",
    );
    expect(resolveModelIntent("openai", "latency-optimized")).toBe(
      "gpt-5.4-nano",
    );
  });

  test("falls back to provider default for unknown providers", () => {
    expect(getProviderDefaultModel("unknown-provider")).toBe("claude-opus-4-6");
    expect(resolveModelIntent("unknown-provider", "quality-optimized")).toBe(
      "claude-opus-4-6",
    );
  });
});

// `RetryProvider`'s legacy `modelIntent` normalization path was removed in
// PR 19 of the unify-llm-callsites plan. The remaining `resolveModelIntent`
// helper lives in `providers/model-intents.ts` for use by the workspace
// migration's snapshot table — see `workspace/migrations/038-unify-llm-
// callsite-configs.ts`.
