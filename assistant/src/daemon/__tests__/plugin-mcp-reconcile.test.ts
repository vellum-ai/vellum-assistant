/**
 * The plugin source reconcile drives MCP reload.
 *
 * Without this, installing a plugin leaves its `mcp.json` servers
 * unconnected and its tools unregistered until an explicit MCP reload, a
 * config edit, or a restart — and, worse in the other direction, an
 * uninstalled or disabled plugin's connected client and registered tools
 * stay callable. The reconcile is the seam every install / uninstall /
 * upgrade / enable / disable already funnels through.
 *
 * The guard is equally load-bearing: a reconcile also fires for plugin
 * edits that touch no `mcp.json`, and reloading on those would tear down
 * every healthy workspace connection to rebuild it for nothing.
 */

import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

let pluginServersChanged = true;

const managerStop = jest.fn(async () => {});
const managerStart = jest.fn(async () => []);

mock.module("../../mcp/effective-config.js", () => ({
  buildEffectiveMcpConfig: () => ({
    servers: {
      unabyss: {
        transport: { type: "streamable-http", url: "https://mcp.example/x" },
        enabled: true,
        defaultRiskLevel: "low",
        maxTools: 20,
        source: "plugin",
      },
    },
    globalMaxTools: 50,
  }),
  pluginMcpServersChangedSinceLastBuild: () => pluginServersChanged,
}));

mock.module("../../mcp/manager.js", () => ({
  getMcpServerManager: () => ({ stop: managerStop, start: managerStart }),
}));

mock.module("../../mcp/mcp-header-store.js", () => ({
  migrateLegacyMcpHeaders: async () => {},
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ mcp: { servers: {}, globalMaxTools: 50 } }),
  invalidateConfigCache: () => {},
}));

mock.module("../../tools/registry.js", () => ({
  registerMcpTools: () => [],
  unregisterAllMcpTools: () => {},
}));

const { reconcilePluginMcpServers } = await import("../mcp-reload-service.js");

describe("reconcilePluginMcpServers", () => {
  beforeEach(() => {
    managerStop.mockClear();
    managerStart.mockClear();
  });

  test("reloads when the plugin-declared set changed", async () => {
    pluginServersChanged = true;

    await reconcilePluginMcpServers();

    expect(managerStop).toHaveBeenCalledTimes(1);
    expect(managerStart).toHaveBeenCalledTimes(1);
  });

  test("does nothing when no plugin changed the set", async () => {
    pluginServersChanged = false;

    await reconcilePluginMcpServers();

    expect(managerStop).not.toHaveBeenCalled();
    expect(managerStart).not.toHaveBeenCalled();
  });
});
