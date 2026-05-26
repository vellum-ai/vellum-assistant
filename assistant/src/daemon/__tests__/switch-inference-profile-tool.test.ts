import { describe, expect, test } from "bun:test";

import type { ProfileEntry } from "../../config/schemas/llm.js";
import type { ToolDefinition } from "../../providers/types.js";
import { buildSwitchInferenceProfileToolDef } from "../switch-inference-profile-tool.js";

function getProfileEnum(toolDef: ToolDefinition): string[] {
  const schema = toolDef.input_schema as {
    properties: { profile: { enum: string[] } };
  };
  return schema.properties.profile.enum;
}

const balanced: ProfileEntry = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  label: "Balanced",
  description: "Good balance of quality, cost, and speed",
  source: "managed",
};

const quality: ProfileEntry = {
  provider: "anthropic",
  model: "claude-opus-4-6",
  label: "Quality",
  description: "Best results with the most capable model",
  source: "managed",
};

const speed: ProfileEntry = {
  provider: "anthropic",
  model: "claude-haiku-4-5",
  label: "Speed",
  description: "Fastest responses at lower cost",
  source: "managed",
};

const auto: ProfileEntry = {
  label: "Auto",
  description: "Automatically routes each query to the best profile",
  source: "managed",
};

describe("buildSwitchInferenceProfileToolDef", () => {
  test("excludes the 'auto' profile from available switch targets", () => {
    const profiles = { auto, balanced, "quality-optimized": quality, "cost-optimized": speed };
    const toolDef = buildSwitchInferenceProfileToolDef(profiles, "auto");

    expect(toolDef).not.toBeNull();
    const enumValues = getProfileEnum(toolDef!);
    expect(enumValues).not.toContain("auto");
    expect(enumValues).toContain("balanced");
    expect(enumValues).toContain("quality-optimized");
    expect(enumValues).toContain("cost-optimized");
  });

  test("returns null when only 'auto' and one real profile exist", () => {
    const profiles = { auto, balanced };
    const toolDef = buildSwitchInferenceProfileToolDef(profiles, "auto");

    expect(toolDef).toBeNull();
  });

  test("excludes disabled profiles alongside 'auto'", () => {
    const disabled: ProfileEntry = { ...balanced, status: "disabled" };
    const profiles = { auto, balanced: disabled, "quality-optimized": quality, "cost-optimized": speed };
    const toolDef = buildSwitchInferenceProfileToolDef(profiles, "auto");

    expect(toolDef).not.toBeNull();
    const enumValues = getProfileEnum(toolDef!);
    expect(enumValues).not.toContain("auto");
    expect(enumValues).not.toContain("balanced");
    expect(enumValues).toContain("quality-optimized");
    expect(enumValues).toContain("cost-optimized");
  });

  test("shows 'Auto (starting on Balanced)' as the current profile label", () => {
    const profiles = { auto, balanced, "quality-optimized": quality, "cost-optimized": speed };
    const toolDef = buildSwitchInferenceProfileToolDef(profiles, "auto");

    expect(toolDef).not.toBeNull();
    expect(toolDef!.description).toContain("Auto (starting on Balanced)");
  });

  test("works with BYOK custom profiles", () => {
    const customBalanced: ProfileEntry = {
      ...balanced,
      provider_connection: "anthropic-personal",
      label: "Balanced",
      source: "user",
    };
    const customQuality: ProfileEntry = {
      ...quality,
      provider_connection: "anthropic-personal",
      label: "Quality",
      source: "user",
    };
    const profiles = { auto, "custom-balanced": customBalanced, "custom-quality-optimized": customQuality };
    const toolDef = buildSwitchInferenceProfileToolDef(profiles, "auto");

    expect(toolDef).not.toBeNull();
    const enumValues = getProfileEnum(toolDef!);
    expect(enumValues).not.toContain("auto");
    expect(enumValues).toContain("custom-balanced");
    expect(enumValues).toContain("custom-quality-optimized");
  });
});
