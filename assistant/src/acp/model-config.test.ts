/**
 * Tests for the pure ACP model-config helpers: flattening an adapter's model
 * `SessionConfigOption` into publishable model info, and the spawn-time
 * precedence ladder.
 */

import { describe, expect, test } from "bun:test";

import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import {
  MODEL_OPTION_MODELS,
  modelOption,
} from "./__tests__/helpers/acp-model-option.js";
import { deriveModelInfo, resolveAcpModel } from "./model-config.js";

const flatModelOption = modelOption("sonnet");

describe("deriveModelInfo", () => {
  test("flattens flat options and reports the current value", () => {
    expect(deriveModelInfo([flatModelOption])).toEqual({
      model: "sonnet",
      modelConfigId: "model",
      availableModels: MODEL_OPTION_MODELS,
    });
  });

  test("flattens grouped options and carries the group name", () => {
    const grouped: SessionConfigOption = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "opus",
      options: [
        {
          group: "anthropic",
          name: "Anthropic",
          options: [
            { value: "opus", name: "Opus" },
            { value: "haiku", name: "Haiku", description: "Fast" },
          ],
        },
        {
          group: "aliases",
          name: "Aliases",
          options: [{ value: "best", name: "Best available" }],
        },
      ],
    };

    expect(deriveModelInfo([grouped])).toEqual({
      model: "opus",
      modelConfigId: "model",
      availableModels: [
        { value: "opus", label: "Opus", group: "Anthropic" },
        {
          value: "haiku",
          label: "Haiku",
          description: "Fast",
          group: "Anthropic",
        },
        { value: "best", label: "Best available", group: "Aliases" },
      ],
    });
  });

  test("matches on id alone when no category is reported", () => {
    const uncategorized: SessionConfigOption = {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "haiku",
      options: [{ value: "haiku", name: "Haiku" }],
    };

    const info = deriveModelInfo([uncategorized]);

    expect(info.modelConfigId).toBe("model");
    expect(info.model).toBe("haiku");
  });

  test("matches on category alone when the id differs", () => {
    const byCategory: SessionConfigOption = {
      type: "select",
      id: "llm",
      name: "LLM",
      category: "model",
      currentValue: "gpt-5",
      options: [{ value: "gpt-5", name: "GPT-5" }],
    };

    expect(deriveModelInfo([byCategory]).modelConfigId).toBe("llm");
  });

  test("ignores a boolean option even when its category is model", () => {
    const booleanOption: SessionConfigOption = {
      type: "boolean",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: true,
    };

    expect(deriveModelInfo([booleanOption])).toEqual({ availableModels: [] });
  });

  test("skips non-model select options and picks the first match", () => {
    const mode: SessionConfigOption = {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "ask",
      options: [{ value: "ask", name: "Ask" }],
    };

    expect(deriveModelInfo([mode, flatModelOption]).modelConfigId).toBe(
      "model",
    );
  });

  test("returns no model info for an empty array", () => {
    expect(deriveModelInfo([])).toEqual({ availableModels: [] });
  });

  test("returns no model info for null", () => {
    expect(deriveModelInfo(null)).toEqual({ availableModels: [] });
  });

  test("returns no model info for undefined", () => {
    expect(deriveModelInfo(undefined)).toEqual({ availableModels: [] });
  });
});

describe("resolveAcpModel", () => {
  test("prefers the requested model over the per-agent one", () => {
    expect(
      resolveAcpModel({ requestedModel: "opus", agentModel: "haiku" }),
    ).toBe("opus");
  });

  test("falls back to the per-agent model", () => {
    expect(resolveAcpModel({ agentModel: "haiku" })).toBe("haiku");
  });

  test("returns undefined when every rung is unset", () => {
    expect(resolveAcpModel({})).toBeUndefined();
  });

  test("treats blank and whitespace-only values as unset", () => {
    expect(
      resolveAcpModel({ requestedModel: "\t\n", agentModel: "haiku" }),
    ).toBe("haiku");
  });

  test("returns undefined when every rung is whitespace", () => {
    expect(
      resolveAcpModel({ requestedModel: " ", agentModel: "  " }),
    ).toBeUndefined();
  });

  test("trims the value it returns", () => {
    expect(resolveAcpModel({ requestedModel: "  opus  " })).toBe("opus");
  });
});
