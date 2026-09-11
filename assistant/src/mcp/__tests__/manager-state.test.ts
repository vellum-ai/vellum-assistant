import { beforeEach, describe, expect, mock, test } from "bun:test";

let completeConnect: (() => void) | undefined;
let connected = true;
let lastError: Error | null = null;
let waitForConnect = false;

mock.module("../client.js", () => ({
  McpClient: class {
    get isConnected() {
      return connected;
    }
    get lastError() {
      return lastError;
    }
    async connect() {
      if (waitForConnect) {
        await new Promise<void>((resolve) => {
          completeConnect = resolve;
        });
      }
    }
    async listTools() {
      return [];
    }
    async disconnect() {
      connected = false;
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
        url: "https://example.com/mcp",
      },
    },
  },
};

describe("MCP manager runtime state", () => {
  beforeEach(() => {
    connected = true;
    lastError = null;
    waitForConnect = false;
    completeConnect = undefined;
  });

  test("retains connecting state until initialization and discovery finish", async () => {
    waitForConnect = true;
    const manager = new McpServerManager();
    const starting = manager.start(config);
    expect(manager.getServerState("example", "workspace")).toBe("connecting");
    completeConnect!();
    await starting;
    expect(manager.getServerState("example", "workspace")).toBe("connected");
    expect(manager.getServerState("example", "plugin")).toBeUndefined();
    connected = false;
    expect(manager.getServerState("example", "workspace")).toBe("error");
    await manager.stop();
    expect(manager.getServerState("example", "workspace")).toBeUndefined();
  });

  test("retains authentication failures without reporting a live client", async () => {
    connected = false;
    const manager = new McpServerManager();
    await manager.start(config);
    expect(manager.getServerState("example", "workspace")).toBe("needs-auth");
    expect(manager.getClient("example")).toBeUndefined();
  });

  test("keeps transport failure distinct from required authentication", async () => {
    connected = false;
    lastError = new Error("Connection refused");
    const manager = new McpServerManager();
    await manager.start(config);
    expect(manager.getServerState("example", "workspace")).toBe("error");
  });
});
