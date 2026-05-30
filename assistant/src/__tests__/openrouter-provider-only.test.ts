import { describe, expect, test } from "bun:test";

import {
  extractOnlyList,
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
        "x-ai/grok-4.20-beta",
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
        "x-ai/grok-4.20-beta",
      );
      const extras = provider.probeExtras({ config: {} });
      expect(extras).toEqual({});
      expect(extras.provider).toBe(undefined);
      expect(extras.reasoning).toBe(undefined);
    });

    test("enables thinking with default detailed summary alongside provider.only", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "x-ai/grok-4.20-beta",
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
        "x-ai/grok-4.20-beta",
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
        "x-ai/grok-4.20-beta",
      );
      const extras = provider.probeExtras({
        config: { thinking: { type: "disabled" }, effort: "low" },
      });
      expect(extras.reasoning).toBe(undefined);
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
  });
});
