/**
 * Coverage for the config the MCP manager is actually started with.
 *
 * The properties worth pinning are the ones a refactor could quietly
 * break, each of which fails silently rather than loudly:
 *
 * 1. Plugin servers reach the manager at all. Reading only `config.mcp`
 *    leaves a plugin's tools missing with nothing logged.
 * 2. A workspace entry of the same id wins, so a plugin cannot redirect a
 *    server the user configured by hand.
 * 3. Every server is attributed. `source` is what `McpClient` reads to
 *    decide whether it may resolve `mcp:<id>:*`, so a plugin server that
 *    came out unattributed would be handed workspace credentials.
 * 4. Change detection tracks the plugin set, since it decides whether a
 *    plugin reconcile reloads MCP at all.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import type { McpConfig } from "../../config/schemas/mcp.js";
import { getWorkspacePluginsDir } from "../../util/platform.js";
import {
  buildEffectiveMcpConfig,
  pluginMcpServersChangedSinceLastBuild,
  resetEffectiveMcpConfigForTests,
} from "../effective-config.js";

function writePlugin(name: string, mcpServers: Record<string, unknown>): void {
  const dir = join(getWorkspacePluginsDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers }));
}

function removePlugin(name: string): void {
  rmSync(join(getWorkspacePluginsDir(), name), {
    recursive: true,
    force: true,
  });
}

function workspaceConfig(servers: McpConfig["servers"]): McpConfig {
  return { servers, globalMaxTools: 50 };
}

function workspaceServer(url: string): McpConfig["servers"][string] {
  return {
    transport: { type: "streamable-http", url },
    enabled: true,
    defaultRiskLevel: "high",
    maxTools: 20,
  };
}

const UNABYSS = {
  unabyss: { type: "streamable-http", url: "https://mcp.unabyss.com" },
};

describe("buildEffectiveMcpConfig", () => {
  beforeEach(() => {
    rmSync(getWorkspacePluginsDir(), { recursive: true, force: true });
    mkdirSync(getWorkspacePluginsDir(), { recursive: true });
    resetEffectiveMcpConfigForTests();
  });

  test("a plugin's server joins the set the manager starts", () => {
    writePlugin("unabyss", UNABYSS);

    const config = buildEffectiveMcpConfig(
      workspaceConfig({
        "from-workspace": workspaceServer("https://config.example/mcp"),
      }),
    );

    expect(Object.keys(config.servers).sort()).toEqual([
      "from-workspace",
      "unabyss",
    ]);
    expect(config.servers.unabyss.transport).toEqual({
      type: "streamable-http",
      url: "https://mcp.unabyss.com",
    });
  });

  test("every server is attributed to its origin", () => {
    writePlugin("unabyss", UNABYSS);

    const config = buildEffectiveMcpConfig(
      workspaceConfig({
        "from-workspace": workspaceServer("https://config.example/mcp"),
      }),
    );

    expect(config.servers.unabyss.source).toEqual("plugin");
    expect(config.servers["from-workspace"].source).toEqual("workspace");
  });

  test("plugin servers arrive at low risk", () => {
    writePlugin("unabyss", UNABYSS);

    const config = buildEffectiveMcpConfig(workspaceConfig({}));
    expect(config.servers.unabyss.defaultRiskLevel).toEqual("low");
  });

  test("a workspace server of the same id wins, and stays workspace-attributed", () => {
    writePlugin("shadowed", {
      shadowed: { type: "streamable-http", url: "https://loses.example/mcp" },
    });

    const config = buildEffectiveMcpConfig(
      workspaceConfig({
        shadowed: workspaceServer("https://wins.example/mcp"),
      }),
    );

    expect(config.servers.shadowed.transport).toEqual({
      type: "streamable-http",
      url: "https://wins.example/mcp",
    });
    // The surviving entry is the user's own, so it keeps its credentials.
    expect(config.servers.shadowed.source).toEqual("workspace");
  });

  test("plugin servers still load when the workspace has no mcp config", () => {
    writePlugin("unabyss", UNABYSS);

    const config = buildEffectiveMcpConfig(undefined);

    expect(Object.keys(config.servers)).toEqual(["unabyss"]);
    expect(config.servers.unabyss.source).toEqual("plugin");
    // The schema's own default, which the manager needs to cap tool count.
    expect(config.globalMaxTools).toEqual(50);
  });

  test("no plugins installed leaves the workspace config alone", () => {
    const workspace = workspaceConfig({
      "from-workspace": workspaceServer("https://config.example/mcp"),
    });

    const config = buildEffectiveMcpConfig(workspace);

    expect(Object.keys(config.servers)).toEqual(["from-workspace"]);
    expect(config.servers["from-workspace"].transport).toEqual(
      workspace.servers["from-workspace"].transport,
    );
  });

  test("a malformed plugin manifest does not remove workspace servers", () => {
    const dir = join(getWorkspacePluginsDir(), "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "broken", version: "1.0.0" }),
    );
    writeFileSync(join(dir, "mcp.json"), "{ not json");

    const config = buildEffectiveMcpConfig(
      workspaceConfig({
        "from-workspace": workspaceServer("https://config.example/mcp"),
      }),
    );

    expect(Object.keys(config.servers)).toEqual(["from-workspace"]);
  });
});

describe("pluginMcpServersChangedSinceLastBuild", () => {
  beforeEach(() => {
    rmSync(getWorkspacePluginsDir(), { recursive: true, force: true });
    mkdirSync(getWorkspacePluginsDir(), { recursive: true });
    resetEffectiveMcpConfigForTests();
  });

  test("true before anything has been built", () => {
    expect(pluginMcpServersChangedSinceLastBuild()).toBe(true);
  });

  test("false right after a build", () => {
    writePlugin("unabyss", UNABYSS);
    buildEffectiveMcpConfig(workspaceConfig({}));

    expect(pluginMcpServersChangedSinceLastBuild()).toBe(false);
  });

  test("true once a plugin is installed", () => {
    buildEffectiveMcpConfig(workspaceConfig({}));
    writePlugin("unabyss", UNABYSS);

    expect(pluginMcpServersChangedSinceLastBuild()).toBe(true);
  });

  test("true once a plugin is uninstalled", () => {
    writePlugin("unabyss", UNABYSS);
    buildEffectiveMcpConfig(workspaceConfig({}));
    removePlugin("unabyss");

    expect(pluginMcpServersChangedSinceLastBuild()).toBe(true);
  });

  test("true once a plugin is disabled", () => {
    writePlugin("unabyss", UNABYSS);
    buildEffectiveMcpConfig(workspaceConfig({}));
    writeFileSync(join(getWorkspacePluginsDir(), "unabyss", ".disabled"), "");

    expect(pluginMcpServersChangedSinceLastBuild()).toBe(true);
  });

  test("true once a declared server's URL moves", () => {
    writePlugin("unabyss", UNABYSS);
    buildEffectiveMcpConfig(workspaceConfig({}));
    writePlugin("unabyss", {
      unabyss: {
        type: "streamable-http",
        url: "https://elsewhere.example/mcp",
      },
    });

    expect(pluginMcpServersChangedSinceLastBuild()).toBe(true);
  });

  test("false for a plugin edit that touches no mcp.json", () => {
    // The guard that keeps an unrelated plugin edit from tearing down every
    // healthy workspace MCP connection.
    writePlugin("unabyss", UNABYSS);
    buildEffectiveMcpConfig(workspaceConfig({}));
    writeFileSync(
      join(getWorkspacePluginsDir(), "unabyss", "package.json"),
      JSON.stringify({ name: "unabyss", version: "2.0.0" }),
    );

    expect(pluginMcpServersChangedSinceLastBuild()).toBe(false);
  });
});
