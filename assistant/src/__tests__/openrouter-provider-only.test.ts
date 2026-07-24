import { describe, expect, test } from "bun:test";

import {
  buildOpenRouterProviderField,
  extractAllowFallbacks,
  extractOnlyList,
  extractOrderList,
  OpenRouterProvider,
  withOpenRouterBodyExtras,
} from "../providers/openrouter/client.js";
import type { SendMessageOptions } from "../providers/types.js";

/** Expose the protected `buildExtraCreateParams` hook for assertion. */
class ProbeOpenRouterProvider extends OpenRouterProvider {
  public probeExtras(options?: SendMessageOptions): Record<string, unknown> {
    return this.buildExtraCreateParams(options);
  }
}

describe("OpenRouter provider.only plumbing", () => {
  describe("extractOnlyList", () => {
    test("returns the list when present and well-formed", () => {
      expect(
        extractOnlyList({ openrouter: { only: ["Anthropic", "Google"] } }),
      ).toEqual(["Anthropic", "Google"]);
    });

    test("filters empty strings and non-strings", () => {
      expect(
        extractOnlyList({
          openrouter: { only: ["Anthropic", "", 42, null, "Google"] },
        }),
      ).toEqual(["Anthropic", "Google"]);
    });

    test("returns [] when openrouter/only is absent or malformed", () => {
      expect(extractOnlyList(undefined)).toEqual([]);
      expect(extractOnlyList({})).toEqual([]);
      expect(extractOnlyList({ openrouter: {} })).toEqual([]);
      expect(extractOnlyList({ openrouter: { only: "Anthropic" } })).toEqual(
        [],
      );
    });
  });

  describe("extractOrderList", () => {
    test("returns the list when present and well-formed", () => {
      expect(
        extractOrderList({ openrouter: { order: ["deepseek", "fireworks"] } }),
      ).toEqual(["deepseek", "fireworks"]);
    });

    test("filters empty strings and non-strings", () => {
      expect(
        extractOrderList({
          openrouter: { order: ["deepseek", "", 7, null, "together"] },
        }),
      ).toEqual(["deepseek", "together"]);
    });

    test("returns [] when openrouter/order is absent or malformed", () => {
      expect(extractOrderList(undefined)).toEqual([]);
      expect(extractOrderList({ openrouter: {} })).toEqual([]);
      expect(extractOrderList({ openrouter: { order: "deepseek" } })).toEqual(
        [],
      );
    });
  });

  describe("extractAllowFallbacks", () => {
    test("returns the boolean when set", () => {
      expect(
        extractAllowFallbacks({ openrouter: { allowFallbacks: false } }),
      ).toBe(false);
      expect(
        extractAllowFallbacks({ openrouter: { allowFallbacks: true } }),
      ).toBe(true);
    });

    test("returns undefined when absent or non-boolean", () => {
      expect(extractAllowFallbacks(undefined)).toBeUndefined();
      expect(extractAllowFallbacks({ openrouter: {} })).toBeUndefined();
      expect(
        extractAllowFallbacks({ openrouter: { allowFallbacks: "false" } }),
      ).toBeUndefined();
    });
  });

  describe("buildOpenRouterProviderField", () => {
    test("defaults order from the catalog for a deepseek model with no config order", () => {
      expect(
        buildOpenRouterProviderField({}, "deepseek/deepseek-v4-flash"),
      ).toEqual({ order: ["deepseek"] });
    });

    test("config order overrides the catalog default", () => {
      expect(
        buildOpenRouterProviderField(
          { openrouter: { order: ["fireworks"] } },
          "deepseek/deepseek-v4-flash",
        ),
      ).toEqual({ order: ["fireworks"] });
    });

    test("no default order for a non-deepseek model", () => {
      expect(
        buildOpenRouterProviderField({}, "x-ai/grok-4.20"),
      ).toBeUndefined();
    });

    test("serializes allow_fallbacks as snake_case only when set", () => {
      expect(
        buildOpenRouterProviderField(
          { openrouter: { allowFallbacks: false } },
          "deepseek/deepseek-v4-flash",
        ),
      ).toEqual({ order: ["deepseek"], allow_fallbacks: false });
      const withoutFlag = buildOpenRouterProviderField(
        {},
        "deepseek/deepseek-v4-flash",
      );
      expect(withoutFlag).not.toHaveProperty("allow_fallbacks");
    });

    test("only composes with the catalog default order", () => {
      expect(
        buildOpenRouterProviderField(
          { openrouter: { only: ["DeepSeek"] } },
          "deepseek/deepseek-v4-flash",
        ),
      ).toEqual({ only: ["DeepSeek"], order: ["deepseek"] });
    });

    test("a caller-set provider.sort suppresses the catalog default order", () => {
      // An explicit routing-priority strategy (`sort`) is the caller's stated
      // intent; injecting the catalog default `order` alongside it would fight
      // that choice.
      expect(
        buildOpenRouterProviderField(
          { provider: { sort: "throughput" } },
          "deepseek/deepseek-v4-flash",
        ),
      ).toEqual({ sort: "throughput" });
    });

    test("a caller-set provider.order suppresses the catalog default order", () => {
      expect(
        buildOpenRouterProviderField(
          { provider: { order: ["fireworks"] } },
          "deepseek/deepseek-v4-flash",
        ),
      ).toEqual({ order: ["fireworks"] });
    });

    test("a bare caller-set provider.only does not suppress the catalog default order", () => {
      // `only` is an allowlist, not a routing priority, so the catalog default
      // still fills the preference among the allowed upstreams.
      expect(
        buildOpenRouterProviderField(
          { provider: { only: ["deepseek"] } },
          "deepseek/deepseek-v4-flash",
        ),
      ).toEqual({ only: ["deepseek"], order: ["deepseek"] });
    });

    test("does not mutate the shared catalog default array across calls", () => {
      const first = buildOpenRouterProviderField(
        {},
        "deepseek/deepseek-v4-flash",
      );
      (first?.order as string[]).push("mutated");
      expect(
        buildOpenRouterProviderField({}, "deepseek/deepseek-v4-flash"),
      ).toEqual({ order: ["deepseek"] });
    });
  });

  describe("withOpenRouterBodyExtras", () => {
    test("moves openrouter.only into top-level provider on config", () => {
      const result = withOpenRouterBodyExtras({
        config: {
          model: "anthropic/claude-opus-4.7",
          openrouter: { only: ["Anthropic"] },
        },
      });
      expect(result?.config).toEqual({
        model: "anthropic/claude-opus-4.7",
        provider: { only: ["Anthropic"] },
      });
      expect((result?.config as Record<string, unknown>).openrouter).toBe(
        undefined,
      );
    });

    test("returns options unchanged when only list is empty", () => {
      const options = {
        config: {
          model: "anthropic/claude-opus-4.7",
          openrouter: { only: [] },
        },
      };
      expect(withOpenRouterBodyExtras(options)).toBe(options);
    });

    test("returns options unchanged when config is absent", () => {
      expect(withOpenRouterBodyExtras(undefined)).toBe(undefined);
      const options = {};
      expect(withOpenRouterBodyExtras(options)).toBe(options);
    });

    test("preserves unrelated config fields", () => {
      const result = withOpenRouterBodyExtras({
        config: {
          model: "anthropic/claude-opus-4.7",
          max_tokens: 1024,
          effort: "high",
          openrouter: { only: ["Anthropic"] },
        },
      });
      expect(result?.config).toEqual({
        model: "anthropic/claude-opus-4.7",
        max_tokens: 1024,
        effort: "high",
        provider: { only: ["Anthropic"] },
      });
    });
  });

  describe("buildExtraCreateParams (OpenAI-compat path)", () => {
    test("emits provider.only in extras when config has openrouter.only", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "x-ai/grok-4.20",
      );
      const extras = provider.probeExtras({
        config: { openrouter: { only: ["xAI"] } },
      });
      expect(extras).toEqual({
        provider: { only: ["xAI"] },
      });
    });

    test("omits reasoning and provider when config is empty", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "x-ai/grok-4.20",
      );
      const extras = provider.probeExtras({ config: {} });
      expect(extras).toEqual({});
      expect(extras.provider).toBe(undefined);
      expect(extras.reasoning).toBe(undefined);
    });

    test("enables thinking with default detailed summary alongside provider.only", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "x-ai/grok-4.20",
      );
      const extras = provider.probeExtras({
        config: {
          thinking: { type: "adaptive" },
          openrouter: { only: ["xAI"] },
        },
      });
      expect(extras).toEqual({
        reasoning: { enabled: true, summary: "detailed" },
        provider: { only: ["xAI"] },
      });
    });

    test("disabled thinking omits reasoning entirely", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "x-ai/grok-4.20",
      );
      const extras = provider.probeExtras({
        config: {
          thinking: { type: "disabled" },
          openrouter: { only: ["xAI"] },
        },
      });
      expect(extras).toEqual({
        provider: { only: ["xAI"] },
      });
      expect(extras.reasoning).toBe(undefined);
    });

    test("nests effort under reasoning and maps `max` to xhigh", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "moonshotai/kimi-k2.6",
      );
      const extras = provider.probeExtras({
        config: {
          thinking: { enabled: true },
          effort: "max",
        },
      });
      expect(extras).toEqual({
        reasoning: { enabled: true, effort: "xhigh", summary: "detailed" },
      });
    });

    test("honors a per-call summary override", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "moonshotai/kimi-k2.6",
      );
      const extras = provider.probeExtras({
        config: {
          thinking: { enabled: true },
          openrouter: { reasoning: { summary: "concise" } },
        },
      });
      expect(extras).toEqual({
        reasoning: { enabled: true, summary: "concise" },
      });
    });

    test("effort without thinking does not emit reasoning", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "x-ai/grok-4.20",
      );
      const extras = provider.probeExtras({
        config: { thinking: { type: "disabled" }, effort: "low" },
      });
      expect(extras.reasoning).toBe(undefined);
    });

    test("disabled thinking with effort none leaves the opt-out to the flat reasoning_effort field", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "x-ai/grok-4.20",
      );
      const extras = provider.probeExtras({
        config: { thinking: { type: "disabled" }, effort: "none" },
      });
      expect(extras).toEqual({});
    });

    test("omitting reasoning avoids 400 from reasoning-only models like DeepSeek R1", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "deepseek/deepseek-r1-0528",
      );
      const extras = provider.probeExtras({
        config: { thinking: { type: "disabled" } },
      });
      expect(extras.reasoning).toBe(undefined);
    });

    test("ignores an invalid summary override and falls back to detailed", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "moonshotai/kimi-k2.6",
      );
      const extras = provider.probeExtras({
        config: {
          thinking: { enabled: true },
          openrouter: { reasoning: { summary: "verbose" } },
        },
      });
      expect(extras).toEqual({
        reasoning: { enabled: true, summary: "detailed" },
      });
    });

    test("defaults provider.order from the catalog for a deepseek model", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "deepseek/deepseek-v4-flash",
      );
      const extras = provider.probeExtras({ config: {} });
      expect(extras).toEqual({ provider: { order: ["deepseek"] } });
    });

    test("config order overrides the catalog default for a deepseek model", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "deepseek/deepseek-v4-flash",
      );
      const extras = provider.probeExtras({
        config: { openrouter: { order: ["fireworks"] } },
      });
      expect(extras).toEqual({ provider: { order: ["fireworks"] } });
    });

    test("deepseek default order composes with only and reasoning", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "deepseek/deepseek-v4-pro",
      );
      const extras = provider.probeExtras({
        config: {
          thinking: { enabled: true },
          openrouter: { only: ["DeepSeek"] },
        },
      });
      expect(extras).toEqual({
        reasoning: { enabled: true, summary: "detailed" },
        provider: { only: ["DeepSeek"], order: ["deepseek"] },
      });
    });

    test("serializes allow_fallbacks as snake_case for a deepseek model", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "deepseek/deepseek-v4-flash",
      );
      const extras = provider.probeExtras({
        config: { openrouter: { allowFallbacks: false } },
      });
      expect(extras).toEqual({
        provider: { order: ["deepseek"], allow_fallbacks: false },
      });
    });

    test("no default order for a non-deepseek model", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "x-ai/grok-4.20",
      );
      const extras = provider.probeExtras({ config: {} });
      expect(extras).toEqual({});
    });

    test("keys the catalog default order off a per-call model override", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "x-ai/grok-4.20",
      );
      const extras = provider.probeExtras({
        config: { model: "deepseek/deepseek-v4-flash" },
      });
      expect(extras).toEqual({ provider: { order: ["deepseek"] } });
    });
  });

  describe("per-model reasoning-effort ceiling", () => {
    test("clamps an inherited max effort down to high for grok-4.5", () => {
      const provider = new ProbeOpenRouterProvider("fake-key", "x-ai/grok-4.5");
      const extras = provider.probeExtras({
        config: { thinking: { enabled: true }, effort: "max" },
      });
      expect(extras).toEqual({
        reasoning: { enabled: true, effort: "high", summary: "detailed" },
      });
    });

    test("clamps an inherited xhigh effort down to high for grok-4.5", () => {
      const provider = new ProbeOpenRouterProvider("fake-key", "x-ai/grok-4.5");
      const extras = provider.probeExtras({
        config: { thinking: { enabled: true }, effort: "xhigh" },
      });
      expect(extras).toEqual({
        reasoning: { enabled: true, effort: "high", summary: "detailed" },
      });
    });

    test("leaves an effort at or below the grok-4.5 ceiling untouched", () => {
      const provider = new ProbeOpenRouterProvider("fake-key", "x-ai/grok-4.5");
      const extras = provider.probeExtras({
        config: { thinking: { enabled: true }, effort: "low" },
      });
      expect(extras).toEqual({
        reasoning: { enabled: true, effort: "low", summary: "detailed" },
      });
    });

    test("leaves models without a catalog ceiling on the provider default (xhigh)", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "x-ai/grok-4.20",
      );
      const extras = provider.probeExtras({
        config: { thinking: { enabled: true }, effort: "max" },
      });
      expect(extras).toEqual({
        reasoning: { enabled: true, effort: "xhigh", summary: "detailed" },
      });
    });

    test("keys the ceiling off a per-call model override, not the constructor model", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "moonshotai/kimi-k2.6",
      );
      const extras = provider.probeExtras({
        config: {
          model: "x-ai/grok-4.5",
          thinking: { enabled: true },
          effort: "max",
        },
      });
      expect(extras).toEqual({
        reasoning: { enabled: true, effort: "high", summary: "detailed" },
      });
    });
  });
});
