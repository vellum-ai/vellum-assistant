import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { FetchLike } from "../fetch-like.js";
import { installPlugin, readInstallMeta } from "../install-from-github.js";
import type { PluginCatalog } from "../search-plugins.js";
import { upgradePlugin } from "../upgrade-plugin.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function packageMaterializer(calls: string[]) {
  return (path: string, version: string, destination: string): number => {
    calls.push(`${path}@${version}`);
    mkdirSync(destination, { recursive: true });
    writeFileSync(
      join(destination, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "fathom",
        version,
      }),
    );
    writeFileSync(
      join(destination, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          fathom: {
            type: "streamable-http",
            url: "https://api.fathom.ai/mcp",
          },
        },
      }),
    );
    return 2;
  };
}

function marketplaceFetch(version: string): FetchLike {
  return (async () =>
    new Response(
      JSON.stringify({
        name: "vellum-assistant",
        plugins: [
          {
            name: "fathom",
            source: {
              source: "local",
              path: "plugins/mcp-catalog/fathom",
              version,
            },
          },
        ],
      }),
      { status: 200 },
    )) as FetchLike;
}

function localCatalog(version: string): PluginCatalog {
  return {
    ref: "bundled",
    matches: [
      {
        name: "fathom",
        path: `local:plugins/mcp-catalog/fathom@${version}`,
        category: null,
        source: {
          kind: "local",
          path: "plugins/mcp-catalog/fathom",
          version,
        },
      },
    ],
  };
}

describe("bundled plugin upgrades", () => {
  test("ignores a newer live manifest version the current binary cannot materialize", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-plugin-upgrade-"));
    roots.push(root);
    const pluginsDir = join(root, "plugins");
    const calls: string[] = [];
    const materializeLocalPackage = packageMaterializer(calls);

    await installPlugin(
      {
        name: "fathom",
        trustedSource: {
          kind: "local",
          path: "plugins/mcp-catalog/fathom",
          version: "1.0.0",
        },
      },
      {
        fetch: marketplaceFetch("1.0.0"),
        workspacePluginsDir: pluginsDir,
        materializeLocalPackage,
      },
    );

    const result = await upgradePlugin(
      { name: "fathom" },
      {
        fetch: marketplaceFetch("9.0.0"),
        workspacePluginsDir: pluginsDir,
        materializeLocalPackage,
        localCatalog: localCatalog("1.0.0"),
        beforeSwap: async () => {},
      },
    );

    expect(result.outcome).toBe("already-up-to-date");
    expect(calls).toEqual(["plugins/mcp-catalog/fathom@1.0.0"]);
  });

  test("materializes the exact inspected path and version", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-plugin-upgrade-"));
    roots.push(root);
    const pluginsDir = join(root, "plugins");
    const calls: string[] = [];
    const materializeLocalPackage = packageMaterializer(calls);

    await installPlugin(
      {
        name: "fathom",
        trustedSource: {
          kind: "local",
          path: "plugins/mcp-catalog/fathom",
          version: "1.0.0",
        },
      },
      {
        fetch: marketplaceFetch("1.0.0"),
        workspacePluginsDir: pluginsDir,
        materializeLocalPackage,
      },
    );

    const result = await upgradePlugin(
      { name: "fathom" },
      {
        fetch: marketplaceFetch("1.1.0"),
        workspacePluginsDir: pluginsDir,
        materializeLocalPackage,
        localCatalog: localCatalog("1.1.0"),
        beforeSwap: async () => {},
      },
    );

    expect(result.outcome).toBe("upgraded");
    expect(calls).toEqual([
      "plugins/mcp-catalog/fathom@1.0.0",
      "plugins/mcp-catalog/fathom@1.1.0",
    ]);
    expect(readInstallMeta(result.target)?.source).toEqual({
      kind: "local",
      path: "plugins/mcp-catalog/fathom",
      version: "1.1.0",
    });
  });
});
