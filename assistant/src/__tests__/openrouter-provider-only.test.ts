import { describe, expect, test } from "bun:test";

import {
  extractOnlyList,
  OpenRouterProvider,
  withOpenRouterBodyExtras,
} from "../providers/openrouter/client.js";
import type { SendMessageOptions } from "../providers/types.js";

/** Expose the protected `buildExtraCreateParams` hook for assertion. */
class ProbeOpenRouterProvider extends OpenRouterProvider {
  public probeExtras(
    options?: SendMessageOptions,
  ): Record<string, unknown> {
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
        config: { model: "anthropic/claude-opus-4.7", openrouter: { only: [] } },
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
        reasoning: { enabled: false },
        provider: { only: ["xAI"] },
      });
    });

    test("omits provider when openrouter.only is absent", () => {
      const provider = new ProbeOpenRouterProvider(
        "fake-key",
        "x-ai/grok-4.20-beta",
      );
      const extras = provider.probeExtras({ config: {} });
      expect(extras).toEqual({ reasoning: { enabled: false } });
      expect(extras.provider).toBe(undefined);
    });

    test("still carries reasoning flag alongside provider.only", () => {
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
        reasoning: { enabled: true },
        provider: { only: ["xAI"] },
      });
    });
  });
});
