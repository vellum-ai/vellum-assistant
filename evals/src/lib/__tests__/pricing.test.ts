import { describe, expect, test } from "bun:test";

import { priceUsageRecord } from "../pricing";

describe("priceUsageRecord", () => {
  test("prices a standard Anthropic record via the local table", () => {
    const result = priceUsageRecord({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      input_tokens: 1_000,
      output_tokens: 500,
    });
    // 1k * 3/1M + 0.5k * 15/1M = 0.003 + 0.0075 = 0.0105
    expect(result.costUsd).toBeCloseTo(0.0105, 6);
    expect(result.diagnostic).toBeUndefined();
  });

  test("prefers actualProvider over provider when both are present", () => {
    // OpenRouter delegating to Anthropic — bills at Anthropic rates and
    // `actualProvider` reflects the underlying provider.
    const result = priceUsageRecord({
      provider: "openrouter",
      actualProvider: "anthropic",
      model: "claude-sonnet-4-5",
      input_tokens: 1_000,
      output_tokens: 500,
    });
    expect(result.costUsd).toBeCloseTo(0.0105, 6);
  });

  test("strips OpenRouter-style provider prefix from model id before lookup", () => {
    const result = priceUsageRecord({
      provider: "anthropic",
      model: "anthropic/claude-haiku-4-5",
      input_tokens: 2_000,
      output_tokens: 1_000,
    });
    // 2k * 1/1M + 1k * 5/1M = 0.002 + 0.005 = 0.007
    expect(result.costUsd).toBeCloseTo(0.007, 6);
  });

  test("does longest-prefix match for date-versioned model ids", () => {
    const result = priceUsageRecord({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20251022",
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    // Falls back to claude-sonnet-4-5 row: 1M * 3/1M = 3
    expect(result.costUsd).toBeCloseTo(3, 4);
  });

  test("trusts daemon-supplied estimatedCostUsd over local pricing", () => {
    const result = priceUsageRecord({
      provider: "anthropic",
      model: "claude-opus-4",
      input_tokens: 1_000,
      output_tokens: 500,
      estimatedCostUsd: 0.123_456,
    });
    expect(result.costUsd).toBe(0.123_456);
  });

  test("missing_provider when neither provider nor actualProvider present", () => {
    const result = priceUsageRecord({
      model: "claude-sonnet-4-5",
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(result.costUsd).toBeUndefined();
    expect(result.diagnostic?.reason).toBe("missing_provider");
    expect(result.diagnostic?.model).toBe("claude-sonnet-4-5");
  });

  test("missing_model when provider present but model is not", () => {
    const result = priceUsageRecord({
      provider: "anthropic",
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(result.diagnostic?.reason).toBe("missing_model");
    expect(result.diagnostic?.provider).toBe("anthropic");
  });

  test("missing_tokens when both input and output tokens are absent", () => {
    const result = priceUsageRecord({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(result.diagnostic?.reason).toBe("missing_tokens");
    expect(result.diagnostic?.provider).toBe("anthropic");
    expect(result.diagnostic?.model).toBe("claude-sonnet-4-5");
  });

  test("unpriced_model when provider/model are unknown to the local table", () => {
    const result = priceUsageRecord({
      provider: "cohere",
      model: "command-r-plus",
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(result.costUsd).toBeUndefined();
    expect(result.diagnostic?.reason).toBe("unpriced_model");
    expect(result.diagnostic?.provider).toBe("cohere");
    expect(result.diagnostic?.model).toBe("command-r-plus");
  });

  test("provider lookup is case-insensitive on the input side", () => {
    const result = priceUsageRecord({
      provider: "Anthropic",
      model: "claude-haiku-4-5",
      input_tokens: 1_000,
      output_tokens: 500,
    });
    expect(result.costUsd).toBeCloseTo(0.0035, 6);
  });

  test("an empty-string provider is treated as missing", () => {
    const result = priceUsageRecord({
      provider: "",
      model: "claude-sonnet-4-5",
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(result.diagnostic?.reason).toBe("missing_provider");
  });

  test("prices OpenAI gpt-5.x rows at the catalog base-tier rate", () => {
    // Mirrors the gpt-5.x rows in `assistant/src/providers/model-catalog.ts`.
    // Evals doesn't model OpenAI's long-context tier multiplier yet
    // (see the pricing.ts file-level docstring) — these assertions
    // lock in the base-tier prices the table is meant to reflect.
    const cases: Array<{
      model: string;
      input: number;
      output: number;
      expected: number;
    }> = [
      {
        model: "gpt-5.5-pro",
        input: 1_000_000,
        output: 1_000_000,
        expected: 210,
      },
      { model: "gpt-5.5", input: 1_000_000, output: 1_000_000, expected: 35 },
      { model: "gpt-5.4", input: 1_000_000, output: 1_000_000, expected: 17.5 },
      {
        model: "gpt-5.4-mini",
        input: 1_000_000,
        output: 1_000_000,
        expected: 5.25,
      },
      {
        model: "gpt-5.4-nano",
        input: 1_000_000,
        output: 1_000_000,
        expected: 1.45,
      },
      {
        model: "gpt-5.2",
        input: 1_000_000,
        output: 1_000_000,
        expected: 15.75,
      },
    ];
    for (const { model, input, output, expected } of cases) {
      const result = priceUsageRecord({
        provider: "openai",
        model,
        input_tokens: input,
        output_tokens: output,
      });
      expect(result.costUsd).toBeCloseTo(expected, 4);
      expect(result.diagnostic).toBeUndefined();
    }
  });

  test("prices Opus 4.5/4.6/4.7 at the catalog $5/$25 rate", () => {
    // The assistant catalog lists Opus 4.5+ at $5/$25. Older Anthropic
    // Opus generations carried $15/$75 but are out-of-scope for evals
    // coverage today — guard against the bug where a stale $15/$75 row
    // would over-report Opus runs by 3x in the cost panel.
    for (const model of [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
    ]) {
      const result = priceUsageRecord({
        provider: "anthropic",
        model,
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      });
      // 1M * 5/1M + 1M * 25/1M = 30
      expect(result.costUsd).toBeCloseTo(30, 4);
      expect(result.diagnostic).toBeUndefined();
    }
  });

  test("normalizes OpenRouter Anthropic dot-versions to the dash-form table key", () => {
    // OpenRouter exposes Anthropic models under `anthropic/claude-X.Y`
    // (dot-separated versions). The catalog the table mirrors uses
    // dashes throughout (`claude-X-Y`). priceUsageRecord must fold dots
    // to dashes for Anthropic before lookup so OpenRouter records don't
    // fall through to unpriced_model and drop out of totalCostUsd.
    const result = priceUsageRecord({
      provider: "openrouter",
      actualProvider: "anthropic",
      model: "anthropic/claude-opus-4.7",
      input_tokens: 2_000_000,
      output_tokens: 1_000_000,
    });
    // 2M * 5/1M + 1M * 25/1M = 10 + 25 = 35
    expect(result.costUsd).toBeCloseTo(35, 4);
    expect(result.diagnostic).toBeUndefined();
  });

  test("does not normalize dots for non-Anthropic providers", () => {
    // OpenAI genuinely ships dot-versioned ids (`gpt-4.1`). The
    // canonicalization rule is Anthropic-only — confirm the OpenAI path
    // keeps dots and still resolves.
    const result = priceUsageRecord({
      provider: "openai",
      model: "gpt-4.1",
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    // 1M * 2.0/1M = 2.0
    expect(result.costUsd).toBeCloseTo(2.0, 4);
    expect(result.diagnostic).toBeUndefined();
  });

  test("model lookup is case-insensitive on the input side", () => {
    // readProvider already lowercases (covered above). readModel must
    // do the same so a record with `"Claude-Sonnet-4-6"` hits the
    // lowercase table row instead of falling through to unpriced_model.
    const result = priceUsageRecord({
      provider: "anthropic",
      model: "Claude-Sonnet-4-6",
      input_tokens: 1_000,
      output_tokens: 500,
    });
    // 1k * 3/1M + 0.5k * 15/1M = 0.003 + 0.0075 = 0.0105
    expect(result.costUsd).toBeCloseTo(0.0105, 6);
    expect(result.diagnostic).toBeUndefined();
  });
});
