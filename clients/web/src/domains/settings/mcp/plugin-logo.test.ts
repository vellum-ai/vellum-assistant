import { describe, expect, test } from "bun:test";

import type { McpPluginDefinition } from "../integration-items";

import { pluginLogoUrl } from "./plugin-logo";

function definition(
  overrides: Partial<McpPluginDefinition> = {},
): McpPluginDefinition {
  return {
    pluginName: "example-mcp",
    displayName: "Example",
    description: "Example tools",
    documentationUrl: "https://example.com/docs",
    logo: "example-mcp.png",
    setup: { mode: "oauth", instructions: "Sign in to Example." },
    ...overrides,
  };
}

describe("pluginLogoUrl", () => {
  test("uses the catalog source revision to invalidate cached logos", () => {
    expect(pluginLogoUrl(definition({ logoRevision: "1.0.3+icon" }))).toEndWith(
      "images/integrations/example-mcp.png?v=1.0.3%2Bicon",
    );
  });

  test("keeps compatibility with definitions that omit a revision", () => {
    expect(pluginLogoUrl(definition())).toEndWith(
      "images/integrations/example-mcp.png",
    );
  });

  test("returns null when no logo is configured", () => {
    expect(pluginLogoUrl(definition({ logo: "" }))).toBeNull();
  });
});
