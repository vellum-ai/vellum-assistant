/**
 * MCP tools reach a process's tool registry only by connecting to each server
 * and listing what it offers. `initializeTools()` does not do that: it loads
 * core built-ins and workspace tools from disk. So every process that hosts
 * agent turns has to run this step for itself or its `mcp__*` calls fail as
 * "Unknown tool" while `assistant tools list`, which reads the daemon's
 * registry over IPC, reports the same tool as registered.
 *
 * These cover the shared step itself: that it registers what a server reports,
 * that a server it cannot reach leaves the process running anyway, and that a
 * restart rebuilds the set rather than adding to it. The guard that the
 * schedule worker actually calls it lives in
 * `src/schedule/__tests__/worker-mcp-tools.test.ts`, next to the worker.
 */

import { afterEach, describe, expect, jest, mock, test } from "bun:test";

const start = jest.fn(async () => [] as unknown[]);

mock.module("../manager.js", () => ({
  getMcpServerManager: () => ({
    start,
    callTool: jest.fn(),
    getClient: () => undefined,
  }),
  stopMcpServerManager: jest.fn(async () => {}),
}));

// Plugin-declared servers are read off disk, so leaving this real would make
// "no servers configured" depend on which plugins the machine running the
// tests happens to have installed.
mock.module("../../plugins/mcp-servers.js", () => ({
  readPluginMcpServers: () => ({ servers: [], issues: [] }),
}));

const { restartConfiguredMcpServers, startConfiguredMcpServers } =
  await import("../startup.js");
const { __resetRegistryForTesting, getTool } =
  await import("../../tools/registry.js");

/** One entry of `McpServerManager.start()`'s result: a server and its tools. */
function serverReporting(serverId: string, toolName: string) {
  return {
    serverId,
    serverConfig: {
      transport: {
        type: "streamable-http",
        url: "https://example.invalid/mcp",
      },
      enabled: true,
      defaultRiskLevel: "low",
      maxTools: 20,
      source: "workspace",
    },
    tools: [
      {
        name: toolName,
        description: "Search email",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
  };
}

/** The `mcp` config block shape a workspace config carries for one server. */
function workspaceConfigWith(serverId: string) {
  return {
    servers: {
      [serverId]: {
        transport: {
          type: "streamable-http" as const,
          url: "https://example.invalid/mcp",
        },
        enabled: true,
        defaultRiskLevel: "low" as const,
        maxTools: 20,
      },
    },
    globalMaxTools: 50,
  };
}

afterEach(() => {
  start.mockClear();
  __resetRegistryForTesting();
});

describe("startConfiguredMcpServers", () => {
  test("registers the tools a server reports, namespaced by server id", async () => {
    start.mockResolvedValueOnce([serverReporting("fastmail", "search_email")]);

    const registered = await startConfiguredMcpServers(
      workspaceConfigWith("fastmail") as never,
    );

    expect(registered).toBe(1);
    expect(getTool("mcp__fastmail__search_email")).toBeDefined();
  });

  test("does nothing when no servers are configured", async () => {
    const registered = await startConfiguredMcpServers(undefined);

    expect(registered).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });

  test("a server that cannot be started leaves the process running", async () => {
    start.mockRejectedValueOnce(new Error("connection refused"));

    const registered = await startConfiguredMcpServers(
      workspaceConfigWith("fastmail") as never,
    );

    expect(registered).toBe(0);
  });
});

describe("restartConfiguredMcpServers", () => {
  test("drops tools the reconnected set no longer reports", async () => {
    start.mockResolvedValueOnce([serverReporting("fastmail", "search_email")]);
    await startConfiguredMcpServers(workspaceConfigWith("fastmail") as never);
    expect(getTool("mcp__fastmail__search_email")).toBeDefined();

    // The test workspace config declares no MCP servers, which is what a
    // removed or disabled one looks like on the next connect.
    await restartConfiguredMcpServers();

    expect(
      getTool("mcp__fastmail__search_email"),
      "A server the config dropped has to stop being callable here. Leaving " +
        "its tools registered is what lets a background schedule keep " +
        "reaching a server the daemon has already disconnected.",
    ).toBeUndefined();
  });

  test("reconnects from the config on disk rather than the previous set", async () => {
    start.mockResolvedValueOnce([serverReporting("fastmail", "search_email")]);
    await startConfiguredMcpServers(workspaceConfigWith("fastmail") as never);
    start.mockClear();

    await restartConfiguredMcpServers();

    expect(
      start,
      "The previous effective config is not reusable: it is the thing that " +
        "changed. A restart rereads it.",
    ).not.toHaveBeenCalled();
  });
});
