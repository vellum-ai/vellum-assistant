import { beforeEach, describe, expect, mock, test } from "bun:test";

let completeConnect: (() => void) | undefined;
let connected = true;
let lastError: Error | null = null;
let waitForConnect = false;
let discoveryError: Error | null = null;

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
      if (discoveryError) {
        throw discoveryError;
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
    completeConnect = undefined;
    discoveryError = null;
  });

  test("retains connecting state until initialization and discovery finish", async () => {
    waitForConnect = true;
    const manager = new McpServerManager();
    const starting = manager.start(config);
    expect(manager.getServerState("example", "workspace")).toBe("connecting");
    completeConnect!();
    await starting;
    expect(manager.getServerState("example", "workspace")).toBe("connected");
    expect(manager.getServerDiagnostic("example", "workspace")).toBeUndefined();
    expect(manager.getServerState("example", "plugin")).toBeUndefined();
    connected = false;
    expect(manager.getServerState("example", "workspace")).toBe("error");
    expect(manager.getServerDiagnostic("example", "workspace")).toBe(
      "connection-closed",
    );
    expect(manager.getServerDiagnostic("example", "plugin")).toBeUndefined();
    await manager.stop();
    expect(manager.getServerState("example", "workspace")).toBeUndefined();
    expect(manager.getServerDiagnostic("example", "workspace")).toBeUndefined();
  });

  test("retains authentication failures without reporting a live client", async () => {
    connected = false;
    const manager = new McpServerManager();
    await manager.start(config);
    expect(manager.getServerState("example", "workspace")).toBe("needs-auth");
    expect(manager.getServerDiagnostic("example", "workspace")).toBe(
      "authorization-required",
    );
    expect(manager.getClient("example")).toBeUndefined();
  });

  test("keeps transport failure distinct from required authentication", async () => {
    connected = false;
    lastError = new Error("Connection refused");
    const manager = new McpServerManager();
    await manager.start(config);
    expect(manager.getServerState("example", "workspace")).toBe("error");
    expect(manager.getServerDiagnostic("example", "workspace")).toBe(
      "connection-failed",
    );
  });

  test("reports tool discovery failure without exposing exception contents", async () => {
    discoveryError = new Error("https://example.com/mcp?private=example-value");
    const manager = new McpServerManager();
    await manager.start(config);
    expect(manager.getServerDiagnostic("example", "workspace")).toBe(
      "tools-discovery-failed",
    );
    expect(manager.getServerDiagnostic("example", "plugin")).toBeUndefined();
  });
});
