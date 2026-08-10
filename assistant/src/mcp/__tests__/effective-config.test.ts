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
 * 3. Plugin ids come back separately, because they are what the caller
 *    passes as `credentialIsolatedServerIds` — dropping them would send
 *    `mcp:<id>:*` credentials to a plugin-chosen URL.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import type { McpConfig } from "../../config/schemas/mcp.js";
import { getWorkspacePluginsDir } from "../../util/platform.js";
import { buildEffectiveMcpConfig } from "../effective-config.js";

function writePlugin(name: string, mcpServers: Record<string, unknown>): void {
  const dir = join(getWorkspacePluginsDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers }));
}

function workspaceConfig(servers: McpConfig["servers"]): McpConfig {
  return { servers, globalMaxTools: 50 };
}

const UNABYSS = {
  unabyss: { type: "streamable-http", url: "https://mcp.unabyss.com" },
};

describe("buildEffectiveMcpConfig", () => {
  beforeEach(() => {
    rmSync(getWorkspacePluginsDir(), { recursive: true, force: true });
    mkdirSync(getWorkspacePluginsDir(), { recursive: true });
  });

  test("a plugin's server joins the set the manager starts", () => {
    writePlugin("unabyss", UNABYSS);

    const { config, pluginServerIds } = buildEffectiveMcpConfig(
      workspaceConfig({
        "from-workspace": {
          transport: {
            type: "streamable-http",
            url: "https://config.example/mcp",
          },
          enabled: true,
          defaultRiskLevel: "high",
          maxTools: 20,
        },
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
    expect([...pluginServerIds]).toEqual(["unabyss"]);
  });

  test("plugin servers arrive at low risk", () => {
    writePlugin("unabyss", UNABYSS);

    const { config } = buildEffectiveMcpConfig(workspaceConfig({}));
    expect(config.servers.unabyss.defaultRiskLevel).toEqual("low");
  });

  test("a workspace server of the same id wins, and is not credential-isolated", () => {
    writePlugin("shadowed", {
      shadowed: { type: "streamable-http", url: "https://loses.example/mcp" },
    });

    const { config, pluginServerIds } = buildEffectiveMcpConfig(
      workspaceConfig({
        shadowed: {
          transport: {
            type: "streamable-http",
            url: "https://wins.example/mcp",
          },
          enabled: true,
          defaultRiskLevel: "high",
          maxTools: 20,
        },
      }),
    );

    expect(config.servers.shadowed.transport).toEqual({
      type: "streamable-http",
      url: "https://wins.example/mcp",
    });
    // The surviving entry is the user's own, so it keeps its credentials.
    expect(pluginServerIds.has("shadowed")).toBe(false);
  });

  test("plugin servers still load when the workspace has no mcp config", () => {
    writePlugin("unabyss", UNABYSS);

    const { config, pluginServerIds } = buildEffectiveMcpConfig(undefined);

    expect(Object.keys(config.servers)).toEqual(["unabyss"]);
    expect([...pluginServerIds]).toEqual(["unabyss"]);
    // The schema's own default, which the manager needs to cap tool count.
    expect(config.globalMaxTools).toEqual(50);
  });

  test("no plugins installed leaves the workspace config alone", () => {
    const workspace = workspaceConfig({
      "from-workspace": {
        transport: {
          type: "streamable-http",
          url: "https://config.example/mcp",
        },
        enabled: true,
        defaultRiskLevel: "high",
        maxTools: 20,
      },
    });

    const { config, pluginServerIds } = buildEffectiveMcpConfig(workspace);

    expect(config.servers).toEqual(workspace.servers);
    expect(pluginServerIds.size).toEqual(0);
  });

  test("a malformed plugin manifest does not remove workspace servers", () => {
    const dir = join(getWorkspacePluginsDir(), "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "broken", version: "1.0.0" }),
    );
    writeFileSync(join(dir, "mcp.json"), "{ not json");

    const { config } = buildEffectiveMcpConfig(
      workspaceConfig({
        "from-workspace": {
          transport: {
            type: "streamable-http",
            url: "https://config.example/mcp",
          },
          enabled: true,
          defaultRiskLevel: "high",
          maxTools: 20,
        },
      }),
    );

    expect(Object.keys(config.servers)).toEqual(["from-workspace"]);
  });
});
