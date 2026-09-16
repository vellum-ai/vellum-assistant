/**
 * McpServerManager.start() applies the shared fair cap after every
 * configured server has been attempted in parallel. A slow earlier
 * server must not prevent later ones from being listed, and later
 * servers must keep tools when the global cap binds.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ResolvedMcpConfig } from "../../config/schemas/mcp.js";

const toolsByServer = new Map<string, Array<{ name: string }>>();
const connectDelays = new Map<string, number>();

mock.module("../client.js", () => ({
  McpClient: class {
    constructor(readonly serverId: string) {}
    get isConnected() {
      return true;
    }
    get lastError() {
      return null;
    }
    async connect() {
      const delay = connectDelays.get(this.serverId) ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    async listTools() {
      return (toolsByServer.get(this.serverId) ?? []).map((tool) => ({
        name: tool.name,
        description: `${this.serverId} ${tool.name}`,
        inputSchema: { type: "object", properties: {} },
      }));
    }
    async disconnect() {}
  },
}));

const { McpServerManager } = await import("../manager.js");

function httpServer(): ResolvedMcpConfig["servers"][string] {
  return {
    source: "workspace",
    transport: {
      type: "streamable-http",
      url: "https://example.invalid/mcp",
    },
  };
}

function configWith(ids: string[]): ResolvedMcpConfig {
  return {
    servers: Object.fromEntries(ids.map((id) => [id, httpServer()])),
  };
}

describe("McpServerManager tool selection", () => {
  beforeEach(() => {
    toolsByServer.clear();
    connectDelays.clear();
  });

  test("later servers keep tools when eight servers exceed the global cap", async () => {
    const ids = Array.from(
      { length: 8 },
      (_, i) => `server-${String(i + 1).padStart(2, "0")}`,
    );
    for (const id of ids) {
      toolsByServer.set(
        id,
        Array.from({ length: 10 }, (_, i) => ({ name: `tool_${i}` })),
      );
    }

    const manager = new McpServerManager();
    const started = await manager.start(configWith(ids));

    expect(started.discoveredToolCount).toBe(80);
    expect(started.keptToolCount).toBe(50);
    expect(started.truncatedServerIds.length).toBeGreaterThan(0);
    expect(
      started.servers.every((server) => server.tools.length > 0),
      "Fair selection must not empty servers 6-8 merely because they were last.",
    ).toBe(true);
    await manager.stop();
  });

  test("a slow earlier server does not prevent later servers from connecting", async () => {
    toolsByServer.set("slow", [{ name: "slow_tool" }]);
    toolsByServer.set("fast", [{ name: "fast_tool" }]);
    connectDelays.set("slow", 40);

    const manager = new McpServerManager();
    const startedAt = Date.now();
    const started = await manager.start(configWith(["slow", "fast"]));
    const elapsed = Date.now() - startedAt;

    expect(started.connectedServerCount).toBe(2);
    expect(started.servers.map((server) => server.serverId).sort()).toEqual([
      "fast",
      "slow",
    ]);
    expect(
      elapsed < 80,
      "Servers connect in parallel, so one 40ms delay should not serialize both.",
    ).toBe(true);
    await manager.stop();
  });
});
