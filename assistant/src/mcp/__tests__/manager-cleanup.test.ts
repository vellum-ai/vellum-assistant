import { beforeEach, describe, expect, mock, test } from "bun:test";

let failClose = true;
let failListTools = false;
let closeCalls = 0;
mock.module("../client.js", () => ({
  McpClient: class {
    isConnected = true;
    constructor(
      readonly serverId: string,
      readonly source: string,
    ) {}
    async connect() {}
    async listTools() {
      if (failListTools) {
        throw new Error("tool discovery failed");
      }
      return [];
    }
    async disconnect(options: { requireCleanup?: boolean }) {
      expect(options.requireCleanup).toBe(true);
      closeCalls++;
      if (failClose) {
        throw new Error("socket close failed");
      }
      this.isConnected = false;
    }
  },
}));
const { McpServerManager } = await import("../manager.js");
const config = {
  servers: {
    example: {
      source: "workspace" as const,
      transport: {
        type: "streamable-http" as const,
        url: "https://mcp.example.com/mcp",
      },
    },
  },
};
beforeEach(() => {
  failClose = true;
  failListTools = false;
  closeCalls = 0;
});

describe("MCP local cleanup acknowledgement", () => {
  test("failed tool discovery retains an unclosed connection for strict cleanup", async () => {
    failListTools = true;
    const manager = new McpServerManager();
    expect(await manager.start(config)).toEqual([]);
    expect(manager.getClient("example")).toBeUndefined();
    expect(manager.hasWorkspaceConnection("example")).toBe(true);
    await expect(manager.stop({ requireCleanup: true })).rejects.toThrow(
      "could not be closed",
    );
    failClose = false;
    await manager.stop({ requireCleanup: true });
    expect(closeCalls).toBe(3);
    expect(manager.hasWorkspaceConnection("example")).toBe(false);
  });
  test("strict cleanup reports failure and retains the handle for retry", async () => {
    const manager = new McpServerManager();
    await manager.start(config);
    await expect(manager.stop({ requireCleanup: true })).rejects.toThrow(
      "could not be closed",
    );
    expect(manager.getClient("example")).toBeUndefined();
    expect(manager.hasWorkspaceConnection("example")).toBe(true);
    failClose = false;
    await manager.stop({ requireCleanup: true });
    expect(closeCalls).toBe(2);
    expect(manager.hasWorkspaceConnection("example")).toBe(false);
  });
  test("normal shutdown tolerates failure but explicit cleanup can retry it", async () => {
    const manager = new McpServerManager();
    await manager.start(config);
    await manager.stop();
    await expect(manager.stop({ requireCleanup: true })).rejects.toThrow(
      "could not be closed",
    );
    failClose = false;
    await manager.stop({ requireCleanup: true });
    expect(closeCalls).toBe(3);
  });
});
