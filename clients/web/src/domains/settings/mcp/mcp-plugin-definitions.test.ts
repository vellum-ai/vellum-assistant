import { describe, expect, test } from "bun:test";

import type {
  PluginsGetResponse,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";

import { buildMcpPluginDefinitions } from "./mcp-plugin-definitions";

type CatalogMatch = PluginsSearchGetResponse["matches"][number];
type InstalledPlugin = PluginsGetResponse["plugins"][number];

function match(overrides: Partial<CatalogMatch> = {}): CatalogMatch {
  return {
    name: "example-mcp",
    path: "local:example-mcp@1.0.0",
    description: "Example tools",
    icon: "🔌",
    category: "productivity",
    source: { kind: "local", path: "example-mcp", version: "1.0.0" },
    integration: {
      kind: "mcp",
      displayName: "Example",
      documentationUrl: "https://example.com/docs",
      verifiedAt: "2026-09-15",
      verification: "documentation-only",
      setup: { mode: "oauth", instructions: "Sign in to Example." },
      logo: "example.png",
    },
    ...overrides,
  };
}

function installed(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: "plugin-example-mcp",
    name: "example-mcp",
    enabled: true,
    description: "Example tools",
    version: "1.0.0",
    category: "productivity",
    icon: "🔌",
    hasIcon: true,
    iconVersion: "logo-v1",
    ...overrides,
  };
}

describe("buildMcpPluginDefinitions", () => {
  test("projects only catalog entries with explicit MCP metadata", () => {
    expect(
      buildMcpPluginDefinitions(
        [match(), match({ name: "ordinary-plugin", integration: undefined })],
        [],
      ),
    ).toEqual([
      {
        pluginName: "example-mcp",
        displayName: "Example",
        description: "Example tools",
        documentationUrl: "https://example.com/docs",
        logo: "example.png",
        oauthProvider: undefined,
        setup: { mode: "oauth", instructions: "Sign in to Example." },
        installed: undefined,
      },
    ]);
  });

  test("joins installed ownership only by the exact plugin name", () => {
    const [definition] = buildMcpPluginDefinitions(
      [match()],
      [
        installed({ name: "example-mcp-copy", iconVersion: "wrong" }),
        installed(),
      ],
    );

    expect(definition?.installed).toEqual({
      icon: "🔌",
      hasIcon: true,
      iconVersion: "logo-v1",
    });
  });
});
