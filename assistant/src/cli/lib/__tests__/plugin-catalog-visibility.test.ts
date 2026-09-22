import { describe, expect, test } from "bun:test";

import {
  filterPluginCatalogByFeatureFlags,
  MCP_CATALOG_QA_INTEGRATIONS_FLAG,
} from "../plugin-catalog-visibility.js";
import type { PluginCatalog, PluginSearchMatch } from "../search-plugins.js";

function match(name: string): PluginSearchMatch {
  return {
    name,
    path: `local:plugins/mcp-catalog/${name}@1.0.0`,
    category: null,
    source: {
      kind: "local",
      path: `plugins/mcp-catalog/${name}`,
      version: "1.0.0",
    },
  };
}

function catalog(names: string[]): PluginCatalog {
  return { ref: "main", matches: names.map(match) };
}

describe("filterPluginCatalogByFeatureFlags", () => {
  test("hides QA integrations while the flag is off", () => {
    const input = catalog([
      "fathom",
      "gamma",
      "guru",
      "intercom",
      "ramp",
      "semrush",
      "typeform",
      "notion",
    ]);

    const result = filterPluginCatalogByFeatureFlags(input, (key) => {
      expect(key).toBe(MCP_CATALOG_QA_INTEGRATIONS_FLAG);
      return false;
    });

    expect(result.matches.map((entry) => entry.name)).toEqual([
      "fathom",
      "notion",
    ]);
  });

  test("returns the full catalog while the flag is on", () => {
    const input = catalog([
      "fathom",
      "gamma",
      "guru",
      "intercom",
      "ramp",
      "semrush",
      "typeform",
    ]);

    const result = filterPluginCatalogByFeatureFlags(input, () => true);

    expect(result).toBe(input);
  });
});
