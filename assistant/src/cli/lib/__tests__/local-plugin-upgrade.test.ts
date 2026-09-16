import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { FetchLike } from "../fetch-like.js";
import { installPlugin, readInstallMeta } from "../install-from-github.js";
import type { PluginCatalog } from "../search-plugins.js";
import { PluginMergeBaselineError, upgradePlugin } from "../upgrade-plugin.js";

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

async function installBundledPlugin(version = "1.0.0") {
  const root = mkdtempSync(join(tmpdir(), "local-plugin-upgrade-"));
  roots.push(root);
  const pluginsDir = join(root, "plugins");
  const calls: string[] = [];
  const materializeLocalPackage = packageMaterializer(calls);
  const installed = await installPlugin(
    {
      name: "fathom",
      trustedSource: {
        kind: "local",
        path: "plugins/mcp-catalog/fathom",
        version,
      },
    },
    {
      fetch: marketplaceFetch(version),
      workspacePluginsDir: pluginsDir,
      materializeLocalPackage,
    },
  );
  return { calls, installed, materializeLocalPackage, pluginsDir };
}

describe("bundled plugin upgrades", () => {
  test("ignores a newer live manifest version the current binary cannot materialize", async () => {
    const fixture = await installBundledPlugin();

    const result = await upgradePlugin(
      { name: "fathom", strategy: "theirs" },
      {
        fetch: marketplaceFetch("9.0.0"),
        workspacePluginsDir: fixture.pluginsDir,
        materializeLocalPackage: fixture.materializeLocalPackage,
        localCatalog: localCatalog("1.0.0"),
        beforeSwap: async () => {},
      },
    );

    expect(result.outcome).toBe("already-up-to-date");
    expect(fixture.calls).toEqual(["plugins/mcp-catalog/fathom@1.0.0"]);
  });

  test("materializes the exact inspected path and version", async () => {
    const fixture = await installBundledPlugin();

    const result = await upgradePlugin(
      { name: "fathom", strategy: "theirs" },
      {
        fetch: marketplaceFetch("1.1.0"),
        workspacePluginsDir: fixture.pluginsDir,
        materializeLocalPackage: fixture.materializeLocalPackage,
        localCatalog: localCatalog("1.1.0"),
        beforeSwap: async () => {},
      },
    );

    expect(result.outcome).toBe("upgraded");
    expect(fixture.calls).toEqual([
      "plugins/mcp-catalog/fathom@1.0.0",
      "plugins/mcp-catalog/fathom@1.1.0",
    ]);
    expect(readInstallMeta(result.target)?.source).toEqual({
      kind: "local",
      path: "plugins/mcp-catalog/fathom",
      version: "1.1.0",
    });
    expect(result.strategy).toBe("theirs");
  });

  test("refuses a theirs upgrade when the installed package has local edits", async () => {
    const fixture = await installBundledPlugin();
    writeFileSync(
      join(fixture.installed.target, "mcp.json"),
      '{"edited":true}',
    );

    for (const dryRun of [false, true]) {
      await expect(
        upgradePlugin(
          { name: "fathom", strategy: "theirs", dryRun },
          {
            fetch: marketplaceFetch("1.1.0"),
            workspacePluginsDir: fixture.pluginsDir,
            materializeLocalPackage: fixture.materializeLocalPackage,
            localCatalog: localCatalog("1.1.0"),
            beforeSwap: async () => {},
          },
        ),
      ).rejects.toBeInstanceOf(PluginMergeBaselineError);
    }

    expect(fixture.calls).toEqual(["plugins/mcp-catalog/fathom@1.0.0"]);
  });

  test("refuses a theirs upgrade when a clean install cannot be proven", async () => {
    const fixture = await installBundledPlugin();
    const meta = readInstallMeta(fixture.installed.target);
    expect(meta).not.toBeNull();
    writeFileSync(
      join(fixture.installed.target, "install-meta.json"),
      `${JSON.stringify({ ...meta, fingerprint: null }, null, 2)}\n`,
    );

    await expect(
      upgradePlugin(
        { name: "fathom", strategy: "theirs" },
        {
          fetch: marketplaceFetch("1.1.0"),
          workspacePluginsDir: fixture.pluginsDir,
          materializeLocalPackage: fixture.materializeLocalPackage,
          localCatalog: localCatalog("1.1.0"),
          beforeSwap: async () => {},
        },
      ),
    ).rejects.toBeInstanceOf(PluginMergeBaselineError);

    expect(fixture.calls).toEqual(["plugins/mcp-catalog/fathom@1.0.0"]);
  });

  test("preserves explicit overwrite behavior for edited bundled packages", async () => {
    const fixture = await installBundledPlugin();
    writeFileSync(
      join(fixture.installed.target, "mcp.json"),
      '{"edited":true}',
    );

    const result = await upgradePlugin(
      { name: "fathom", strategy: "overwrite" },
      {
        fetch: marketplaceFetch("1.1.0"),
        workspacePluginsDir: fixture.pluginsDir,
        materializeLocalPackage: fixture.materializeLocalPackage,
        localCatalog: localCatalog("1.1.0"),
        beforeSwap: async () => {},
      },
    );

    expect(result.outcome).toBe("upgraded");
    expect(result.strategy).toBe("overwrite");
    expect(fixture.calls).toEqual([
      "plugins/mcp-catalog/fathom@1.0.0",
      "plugins/mcp-catalog/fathom@1.1.0",
    ]);
  });

  test("keeps explicit ours and assistant strategies unavailable for bundled packages", async () => {
    const fixture = await installBundledPlugin();

    for (const strategy of ["ours", "assistant"] as const) {
      await expect(
        upgradePlugin(
          { name: "fathom", strategy },
          {
            fetch: marketplaceFetch("1.1.0"),
            workspacePluginsDir: fixture.pluginsDir,
            materializeLocalPackage: fixture.materializeLocalPackage,
            localCatalog: localCatalog("1.1.0"),
            beforeSwap: async () => {},
          },
        ),
      ).rejects.toBeInstanceOf(PluginMergeBaselineError);
    }

    expect(fixture.calls).toEqual(["plugins/mcp-catalog/fathom@1.0.0"]);
  });
});
