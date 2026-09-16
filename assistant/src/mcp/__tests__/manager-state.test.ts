import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

let completeConnect: (() => void) | undefined;
let completeToolDiscovery: (() => void) | undefined;
let connected = true;
let lastError: Error | null = null;
let waitForConnect = false;
let waitForToolDiscovery = false;
const unexpectedCloseHandlers = new Map<string, () => void>();

mock.module("../client.js", () => ({
  McpClient: class {
    constructor(
      serverId: string,
      _source: string,
      onUnexpectedClose: () => void,
    ) {
      unexpectedCloseHandlers.set(serverId, onUnexpectedClose);
    }
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
      if (waitForToolDiscovery) {
        await new Promise<void>((resolve) => {
          completeToolDiscovery = resolve;
        });
      }
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
    waitForToolDiscovery = false;
    completeConnect = undefined;
    completeToolDiscovery = undefined;
    unexpectedCloseHandlers.clear();
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

  test("records and reports an unexpected close", async () => {
    const onUnexpectedClose = jest.fn();
    const manager = new McpServerManager(onUnexpectedClose);
    await manager.start(config);

    connected = false;
    unexpectedCloseHandlers.get("example")!();

    expect(manager.getServerState("example", "workspace")).toBe("error");
    expect(manager.getClient("example")).toBeDefined();
    expect(onUnexpectedClose).toHaveBeenCalledWith();
  });

  test("does not restore connected state when the server closes during discovery", async () => {
    waitForToolDiscovery = true;
    const manager = new McpServerManager();
    const starting = manager.start(config);
    while (!completeToolDiscovery) {
      await Promise.resolve();
    }

    connected = false;
    unexpectedCloseHandlers.get("example")!();
    completeToolDiscovery!();
    await starting;

    expect(manager.getServerState("example", "workspace")).toBe("error");
  });
});
