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

  test("buildInitialConfig seeds mainAgent callSite for Anthropic default", () => {
    expect(
      buildInitialConfig({
        "llm.default.provider": "anthropic",
        "llm.default.model": "claude-opus-4-7",
      }),
    ).toEqual({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-opus-4-7",
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

  test("buildInitialConfig respects explicit non-default Anthropic models", () => {
    expect(
      buildInitialConfig({
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

  test("buildInitialConfig respects active profile provider overrides", () => {
    expect(
      buildInitialConfig({
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

  test("buildInitialConfig uses active profile model when deciding to seed", () => {
    expect(
      buildInitialConfig({
        "llm.activeProfile": "fast",
        "llm.profiles.fast.provider": "anthropic",
        "llm.profiles.fast.model": "claude-haiku-4-5-20251001",
      }),
    ).toEqual({
      llm: {
        activeProfile: "fast",
        profiles: {
          fast: {
            provider: "anthropic",
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
