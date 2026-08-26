import { describe, expect, test } from "bun:test";

import {
  appendOpenRouterCustomModel,
  collectOpenRouterPickerModels,
  harvestOpenRouterProfileModels,
} from "@/domains/settings/ai/openrouter-custom-models";

describe("collectOpenRouterPickerModels", () => {
  const catalog = [
    { id: "x-ai/grok-4.6", displayName: "Grok 4.6" },
    { id: "x-ai/grok-4.5", displayName: "Grok 4.5" },
  ];

  test("appends stored and bound extras after the catalog", () => {
    expect(
      collectOpenRouterPickerModels(
        catalog,
        [{ id: "openrouter/fusion", displayName: "Fusion" }],
        [{ id: "vendor/custom" }],
      ),
    ).toEqual([
      { id: "x-ai/grok-4.6", displayName: "Grok 4.6" },
      { id: "x-ai/grok-4.5", displayName: "Grok 4.5" },
      { id: "openrouter/fusion", displayName: "Fusion" },
      { id: "vendor/custom", displayName: "vendor/custom" },
    ]);
  });

  test("skips catalog duplicates and empty ids", () => {
    expect(
      collectOpenRouterPickerModels(
        catalog,
        [{ id: "x-ai/grok-4.6", displayName: "Ignored" }, { id: "  " }],
        [{ id: "openrouter/fusion" }, { id: "openrouter/fusion" }],
      ),
    ).toEqual([
      ...catalog,
      { id: "openrouter/fusion", displayName: "openrouter/fusion" },
    ]);
  });
});

describe("harvestOpenRouterProfileModels", () => {
  test("collects OpenRouter profile models and ignores other providers", () => {
    expect(
      harvestOpenRouterProfileModels({
        custom: { provider: "openrouter", model: "vendor/custom" },
        other: { provider: "anthropic", model: "claude-opus-5" },
        empty: { provider: "openrouter", model: "  " },
      }),
    ).toEqual([{ id: "vendor/custom" }]);
  });
});

describe("appendOpenRouterCustomModel", () => {
  test("appends a new id and refreshes an existing display name", () => {
    expect(
      appendOpenRouterCustomModel([], { id: "vendor/custom", displayName: "Custom" }),
    ).toEqual([{ id: "vendor/custom", displayName: "Custom" }]);
    expect(
      appendOpenRouterCustomModel(
        [{ id: "vendor/custom", displayName: "Old" }],
        { id: "vendor/custom", displayName: "New" },
      ),
    ).toEqual([{ id: "vendor/custom", displayName: "New" }]);
  });
});
