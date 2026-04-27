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
    expect(resolveModelIntent("gemini", "latency-optimized")).toBe(
      "gemini-3.1-flash-lite-preview",
    );
    expect(resolveModelIntent("gemini", "quality-optimized")).toBe(
      "gemini-3.1-pro-preview",
    );
    expect(resolveModelIntent("gemini", "vision-optimized")).toBe(
      "gemini-3-flash-preview",
    );
  });

  test("uses GPT-5.5 as the OpenAI provider default", () => {
    expect(getProviderDefaultModel("openai")).toBe("gpt-5.5");
  });

  test("falls back to provider default for unknown providers", () => {
    expect(getProviderDefaultModel("unknown-provider")).toBe(
      "claude-sonnet-4-6",
    );
    expect(resolveModelIntent("unknown-provider", "quality-optimized")).toBe(
      "claude-sonnet-4-6",
    );
  });
});

// `RetryProvider` normalizes outbound calls through call-site routing
// (`resolveCallSiteConfig` against `llm.callSites.<id>` / `llm.default`).
// The `resolveModelIntent` helper exercised above lives in
// `providers/model-intents.ts` and is used by the unify-llm workspace
// migration's snapshot table (see
// `workspace/migrations/038-unify-llm-callsite-configs.ts`) to seed
// `llm.default` from any pre-existing `modelIntent` setting.
