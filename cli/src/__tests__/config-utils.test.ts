import { describe, expect, test } from "bun:test";

import { buildInitialConfig, buildNestedConfig } from "../lib/config-utils.js";

describe("config-utils", () => {
  test("buildNestedConfig only converts dot-notation values", () => {
    expect(
      buildNestedConfig({
        "llm.default.provider": "anthropic",
        "llm.default.model": "claude-sonnet-4-6",
      }),
    ).toEqual({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      },
    });
  });

  test("buildInitialConfig seeds Opus for the Anthropic main thread", () => {
    expect(
      buildInitialConfig({
        "llm.default.provider": "anthropic",
        "llm.default.model": "claude-sonnet-4-6",
      }),
    ).toEqual({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
        callSites: {
          mainAgent: {
            model: "claude-opus-4-7",
            maxTokens: 32000,
          },
        },
      },
    });
  });

  test("buildInitialConfig seeds Opus when provider falls back to Anthropic", () => {
    expect(
      buildInitialConfig({
        "services.inference.mode": "managed",
      }),
    ).toEqual({
      services: {
        inference: {
          mode: "managed",
        },
      },
      llm: {
        callSites: {
          mainAgent: {
            model: "claude-opus-4-7",
            maxTokens: 32000,
          },
        },
      },
    });
  });

  test("buildInitialConfig preserves explicit mainAgent overrides", () => {
    expect(
      buildInitialConfig({
        "llm.default.provider": "anthropic",
        "llm.default.model": "claude-sonnet-4-6",
        "llm.callSites.mainAgent.model": "claude-haiku-4-5-20251001",
      }),
    ).toEqual({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
        callSites: {
          mainAgent: {
            model: "claude-haiku-4-5-20251001",
          },
        },
      },
    });
  });

  test("buildInitialConfig does not seed Opus for non-Anthropic providers", () => {
    expect(
      buildInitialConfig({
        "llm.default.provider": "openai",
        "llm.default.model": "gpt-5.5",
      }),
    ).toEqual({
      llm: {
        default: {
          provider: "openai",
          model: "gpt-5.5",
        },
      },
    });
  });
});
