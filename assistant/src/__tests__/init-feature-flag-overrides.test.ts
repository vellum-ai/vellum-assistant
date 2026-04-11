/**
 * Tests for initFeatureFlagOverrides() — the async gateway IPC call that
 * pre-populates the feature flag cache before CLI program construction.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  clearFeatureFlagOverridesCache,
  initFeatureFlagOverrides,
  isAssistantFeatureFlagEnabled,
} from "../config/assistant-feature-flags.js";
import {
  _resetGatewayIpcClientForTesting,
  GatewayIpcClient,
} from "../ipc/gateway-client.js";

// ---------------------------------------------------------------------------
// Helpers — lightweight IPC server for testing
// ---------------------------------------------------------------------------

type IpcRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

function createTestIpcServer(
  socketPath: string,
  handler: (req: IpcRequest) => unknown,
): Server {
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const req = JSON.parse(line) as IpcRequest;
        const result = handler(req);
        socket.write(JSON.stringify({ id: req.id, result }) + "\n");
      }
    });
  });
  return server;
}

function listenAsync(server: Server, path: string): Promise<void> {
  return new Promise((resolve) => server.listen(path, resolve));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let tmpDir: string;
let socketPath: string;
let testServer: Server | null = null;

beforeEach(() => {
  clearFeatureFlagOverridesCache();
  _resetGatewayIpcClientForTesting();
  tmpDir = mkdtempSync(join(tmpdir(), "ipc-test-"));
  socketPath = join(tmpDir, "gateway.sock");
});

afterEach(() => {
  clearFeatureFlagOverridesCache();
  _resetGatewayIpcClientForTesting();
  if (testServer) {
    testServer.close();
    testServer = null;
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("initFeatureFlagOverrides", () => {
  it("populates cache from gateway IPC response", async () => {
    testServer = createTestIpcServer(socketPath, (req) => {
      if (req.method === "getFeatureFlags") {
        return { "foo-enabled": true, "bar-enabled": true };
      }
      return null;
    });
    await listenAsync(testServer, socketPath);

    const client = new GatewayIpcClient(socketPath);
    mock.module("../ipc/gateway-client.js", () => ({
      getGatewayIpcClient: () => client,
      stopGatewayIpcClient: () => client.stop(),
      _resetGatewayIpcClientForTesting: () => {},
      GatewayIpcClient,
    }));

    client.connect();
    await new Promise<void>((resolve) => {
      if (client.isConnected()) return resolve();
      client.once("connected", resolve);
    });

    await initFeatureFlagOverrides();

    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
    expect(isAssistantFeatureFlagEnabled("bar-enabled", config)).toBe(true);

    client.stop();
  });

  it("falls back gracefully when gateway IPC is unavailable", async () => {
    const client = new GatewayIpcClient(join(tmpDir, "nonexistent.sock"));
    mock.module("../ipc/gateway-client.js", () => ({
      getGatewayIpcClient: () => client,
      stopGatewayIpcClient: () => client.stop(),
      _resetGatewayIpcClientForTesting: () => {},
      GatewayIpcClient,
    }));

    client.connect();

    // Should not throw — waits up to 5s for connection then falls back
    await initFeatureFlagOverrides();

    // Without gateway data or file, undeclared flags default to true
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);

    client.stop();
  }, 10_000);

  it("receives feature_flags_changed event and updates cache", async () => {
    testServer = createTestIpcServer(socketPath, (req) => {
      if (req.method === "getFeatureFlags") {
        return { "initial-flag": true };
      }
      return null;
    });
    await listenAsync(testServer, socketPath);

    const client = new GatewayIpcClient(socketPath);
    mock.module("../ipc/gateway-client.js", () => ({
      getGatewayIpcClient: () => client,
      stopGatewayIpcClient: () => client.stop(),
      _resetGatewayIpcClientForTesting: () => {},
      GatewayIpcClient,
    }));

    client.connect();
    await new Promise<void>((resolve) => {
      if (client.isConnected()) return resolve();
      client.once("connected", resolve);
    });

    await initFeatureFlagOverrides();

    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("initial-flag", config)).toBe(true);

    // Simulate the gateway pushing a feature_flags_changed event.
    // The initFeatureFlagOverrides() function registers a listener on the
    // client's EventEmitter, so emitting here triggers the handler directly.
    client.emit("feature_flags_changed", {
      "initial-flag": false,
      "new-flag": true,
    });

    // Give the event handler a tick to process
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(isAssistantFeatureFlagEnabled("initial-flag", config)).toBe(false);
    expect(isAssistantFeatureFlagEnabled("new-flag", config)).toBe(true);

    client.stop();
  });

  it("does not cache empty gateway response", async () => {
    testServer = createTestIpcServer(socketPath, (req) => {
      if (req.method === "getFeatureFlags") {
        return {};
      }
      return null;
    });
    await listenAsync(testServer, socketPath);

    const client = new GatewayIpcClient(socketPath);
    mock.module("../ipc/gateway-client.js", () => ({
      getGatewayIpcClient: () => client,
      stopGatewayIpcClient: () => client.stop(),
      _resetGatewayIpcClientForTesting: () => {},
      GatewayIpcClient,
    }));

    client.connect();
    await new Promise<void>((resolve) => {
      if (client.isConnected()) return resolve();
      client.once("connected", resolve);
    });

    await initFeatureFlagOverrides();

    // Undeclared flags without overrides default to true (not false from
    // a cached empty map)
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);

    client.stop();
  });
});
