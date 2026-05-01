import { readFileSync, rmSync } from "fs";
import { describe, expect, test } from "bun:test";

import { buildNestedConfig, writeInitialConfig } from "../lib/config-utils.js";

function readInitialConfig(
  configValues: Record<string, string>,
): Record<string, unknown> {
  const path = writeInitialConfig(configValues);
  expect(path).toBeDefined();
  try {
    return JSON.parse(readFileSync(path!, "utf-8")) as Record<string, unknown>;
  } finally {
    if (path !== undefined) rmSync(path, { force: true });
  }
}

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

  test("writeInitialConfig does not add a mainAgent callSite for Anthropic defaults", () => {
    expect(
      readInitialConfig({
        "llm.default.provider": "anthropic",
        "llm.default.model": "claude-opus-4-7",
      }),
    ).toEqual({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-opus-4-7",
        },
      },
    });
  });

  test("writeInitialConfig preserves profile-based Anthropic model selection", () => {
    expect(
      readInitialConfig({
        "llm.activeProfile": "quality-optimized",
        "llm.profiles.quality-optimized.provider": "anthropic",
        "llm.profiles.quality-optimized.model": "claude-opus-4-7",
        "llm.profiles.quality-optimized.maxTokens": "32000",
      }),
    ).toEqual({
      llm: {
        activeProfile: "quality-optimized",
        profiles: {
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-opus-4-7",
            maxTokens: "32000",
          },
        },
      },
    });
  });

  test("writeInitialConfig preserves explicit mainAgent overrides without rewriting them", () => {
    expect(
      readInitialConfig({
        "llm.default.provider": "anthropic",
        "llm.default.model": "claude-opus-4-7",
        "llm.callSites.mainAgent.model": "claude-haiku-4-5-20251001",
      }),
    ).toEqual({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-opus-4-7",
        },
        callSites: {
          mainAgent: {
            model: "claude-haiku-4-5-20251001",
          },
        },
      },
    });
  });

  test("writeInitialConfig respects explicit non-default Anthropic models", () => {
    expect(
      readInitialConfig({
        "llm.default.provider": "anthropic",
        "llm.default.model": "claude-haiku-4-5-20251001",
      }),
    ).toEqual({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
        },
      },
    });
  });

  test("writeInitialConfig leaves active OpenAI profile config unchanged", () => {
    expect(
      readInitialConfig({
        "llm.activeProfile": "fast",
        "llm.profiles.fast.provider": "openai",
        "llm.profiles.fast.model": "gpt-5.5",
      }),
    ).toEqual({
      llm: {
        activeProfile: "fast",
        profiles: {
          fast: {
            provider: "openai",
            model: "gpt-5.5",
          },
        },
      },
    });
  });

  test("writeInitialConfig does not add Opus for non-Anthropic providers", () => {
    expect(
      readInitialConfig({
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
