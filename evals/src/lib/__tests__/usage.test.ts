import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../adapter";
import { mergeUsageSummaries, summarizeAssistantUsage } from "../usage";

function usageEvent(usage: Record<string, unknown>): AgentEvent {
  return { message: { type: "usage", usage } };
}

describe("summarizeAssistantUsage", () => {
  test("returns missing status and no totals when there are no usage events", () => {
    const summary = summarizeAssistantUsage([
      { message: { type: "assistant_text_delta", text: "hi" } },
    ]);
    expect(summary.requests).toEqual([]);
    expect(summary.totalInputTokens).toBeUndefined();
    expect(summary.totalOutputTokens).toBeUndefined();
    expect(summary.totalCostUsd).toBeUndefined();
    expect(summary.costStatus).toBe("missing");
    expect(summary.costDiagnostics).toBeUndefined();
  });

  test("sums tokens and dollars cleanly when every record is priceable", () => {
    const summary = summarizeAssistantUsage([
      usageEvent({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        input_tokens: 1_000,
        output_tokens: 500,
      }),
      usageEvent({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        input_tokens: 2_000,
        output_tokens: 1_000,
      }),
    ]);
    expect(summary.totalInputTokens).toBe(3_000);
    expect(summary.totalOutputTokens).toBe(1_500);
    expect(summary.totalCostUsd).toBeCloseTo(0.0105 + 0.007, 6);
    expect(summary.costStatus).toBe("ok");
    expect(summary.costDiagnostics).toBeUndefined();
  });

  test("reports partial status with per-request diagnostics when some records lack pricing identity", () => {
    const summary = summarizeAssistantUsage([
      usageEvent({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        input_tokens: 1_000,
        output_tokens: 500,
      }),
      // Missing provider — diagnostic, no cost contribution.
      usageEvent({
        model: "claude-haiku-4-5",
        input_tokens: 100,
        output_tokens: 50,
      }),
      // Unknown model — diagnostic, no cost contribution.
      usageEvent({
        provider: "cohere",
        model: "command-r-plus",
        input_tokens: 100,
        output_tokens: 50,
      }),
    ]);
    expect(summary.totalInputTokens).toBe(1_200);
    expect(summary.totalCostUsd).toBeCloseTo(0.0105, 6);
    expect(summary.costStatus).toBe("partial");
    expect(summary.costDiagnostics).toEqual([
      {
        requestIndex: 1,
        reason: "missing_provider",
        model: "claude-haiku-4-5",
      },
      {
        requestIndex: 2,
        reason: "unpriced_model",
        provider: "cohere",
        model: "command-r-plus",
      },
    ]);
  });

  test("reports missing status when every usage record is unpriceable", () => {
    const summary = summarizeAssistantUsage([
      usageEvent({ model: "claude-sonnet-4-5", input_tokens: 100 }),
      usageEvent({ provider: "anthropic", input_tokens: 100 }),
    ]);
    expect(summary.totalCostUsd).toBeUndefined();
    expect(summary.costStatus).toBe("missing");
    expect(summary.costDiagnostics).toHaveLength(2);
    expect(summary.costDiagnostics?.[0]?.reason).toBe("missing_provider");
    expect(summary.costDiagnostics?.[1]?.reason).toBe("missing_model");
  });

  test("trusts a daemon-supplied estimatedCostUsd field", () => {
    const summary = summarizeAssistantUsage([
      usageEvent({
        provider: "anthropic",
        model: "claude-opus-4",
        input_tokens: 1_000,
        output_tokens: 500,
        estimatedCostUsd: 0.999,
      }),
    ]);
    expect(summary.totalCostUsd).toBe(0.999);
    expect(summary.costStatus).toBe("ok");
  });

  test("skips events whose .usage is not a plain object", () => {
    const summary = summarizeAssistantUsage([
      { message: { type: "usage", usage: null } },
      { message: { type: "usage", usage: ["bogus"] } },
      { message: { type: "usage", usage: "string" } },
      usageEvent({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        input_tokens: 1_000,
        output_tokens: 500,
      }),
    ]);
    expect(summary.requests).toHaveLength(1);
    expect(summary.totalCostUsd).toBeCloseTo(0.0105, 6);
  });
});

test("mergeUsageSummaries re-prices combined daemon and recording usage records", () => {
  const summary = mergeUsageSummaries(
    summarizeAssistantUsage([
      usageEvent({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        input_tokens: 1_000,
        output_tokens: 500,
      }),
    ]),
    {
      requests: [
        {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          input_tokens: 2_000,
          output_tokens: 1_000,
        },
      ],
    },
  );

  expect(summary.requests).toHaveLength(2);
  expect(summary.totalInputTokens).toBe(3_000);
  expect(summary.totalCostUsd).toBeCloseTo(0.0105 + 0.007, 6);
  expect(summary.costStatus).toBe("ok");
});
