import { describe, expect, test } from "bun:test";

import { mapAssistantFeatureFlagEntriesForStore } from "@/hooks/use-assistant-feature-flag-sync";
import type { AssistantFeatureFlagsGetResponse } from "@/generated/gateway/types.gen";

type FeatureFlagEntry = AssistantFeatureFlagsGetResponse["flags"][number];

function flag(key: string, enabled: boolean | string): FeatureFlagEntry {
  return { key, enabled } as FeatureFlagEntry;
}

describe("mapAssistantFeatureFlagEntriesForStore", () => {
  test("maps the legacy MCP settings key to the add-server gate", () => {
    const { boolFlags } = mapAssistantFeatureFlagEntriesForStore([
      flag("mcp-settings", true),
    ]);

    expect(boolFlags).toEqual({ mcpAddServer: true });
    expect(boolFlags).not.toHaveProperty("mcpSettings");
  });

  test("prefers canonical MCP add-server payloads over legacy MCP settings payloads", () => {
    const { boolFlags } = mapAssistantFeatureFlagEntriesForStore([
      flag("mcp-settings", true),
      flag("mcp-add-server", false),
    ]);

    expect(boolFlags).toEqual({ mcpAddServer: false });
    expect(boolFlags).not.toHaveProperty("mcpSettings");
  });
});
