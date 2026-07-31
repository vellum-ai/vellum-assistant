/**
 * Tests for the CacheHealthCard cache-breakdown rendering. Renders to
 * static markup (no DOM), mirroring `call-rail.test.tsx`, and asserts the
 * provider-aware hit-rate math and status banner — Anthropic reports
 * cache counters disjoint from `inputTokens`, OpenAI folds the cached
 * subset into `inputTokens`, and absent counters render nothing.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CacheHealthCard } from "./cache-health-card";
import type { LLMCallSummary } from "@vellumai/assistant-api";

function summary(overrides: Partial<LLMCallSummary>): LLMCallSummary {
  return { provider: "anthropic", ...overrides };
}

describe("CacheHealthCard", () => {
  test("flags a full cache miss when nothing was read from cache", () => {
    const html = renderToStaticMarkup(
      <CacheHealthCard
        summary={summary({
          cacheCreationInputTokens: 36634,
          cacheReadInputTokens: 0,
          inputTokens: 12,
        })}
      />,
    );

    expect(html).toContain("Full cache miss");
    expect(html).toContain("0%");
    // Anthropic-style re-created hint surfaces the wasted creation tokens.
    expect(html).toContain("36,634");
  });

  test("reports healthy reuse when nearly all tokens are cached", () => {
    const html = renderToStaticMarkup(
      <CacheHealthCard
        summary={summary({
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 9500,
          inputTokens: 100,
        })}
      />,
    );

    expect(html).toContain("Healthy cache reuse");
    expect(html).toContain("99%");
  });

  test("treats OpenAI inputTokens as inclusive of the cached subset", () => {
    // GIVEN no creation counter and read as a subset of inputTokens, the
    // bar must not double-count: total is inputTokens, fresh is the rest.
    const html = renderToStaticMarkup(
      <CacheHealthCard
        summary={summary({
          provider: "openai",
          cacheReadInputTokens: 600,
          inputTokens: 1000,
        })}
      />,
    );

    expect(html).toContain("Partial cache reuse");
    expect(html).toContain("60%");
  });

  test("renders an unavailable note when no cache counters are present", () => {
    const html = renderToStaticMarkup(
      <CacheHealthCard summary={summary({ inputTokens: 1000 })} />,
    );

    expect(html).toContain("didn&#x27;t report prompt-cache usage");
  });

  test("renders nothing without a summary", () => {
    expect(renderToStaticMarkup(<CacheHealthCard summary={null} />)).toBe("");
    expect(renderToStaticMarkup(<CacheHealthCard summary={undefined} />)).toBe(
      "",
    );
  });

  test("renders nothing for a provider-only summary", () => {
    const html = renderToStaticMarkup(
      <CacheHealthCard summary={{ provider: "anthropic" }} />,
    );

    expect(html).toBe("");
  });
});
