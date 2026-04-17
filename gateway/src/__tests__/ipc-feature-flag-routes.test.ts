import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { testSecurityDir, testWorkspaceDir } from "./test-preload.js";

const protectedDir = testSecurityDir;
const featureFlagStorePath = join(protectedDir, "feature-flags.json");
const remoteFeatureFlagStorePath = join(
  protectedDir,
  "feature-flags-remote.json",
);

// Write the test registry to an isolated temp path
const defaultsPath = join(protectedDir, "feature-flag-registry.json");

// Socket path for the IPC server
const socketPath = join(testWorkspaceDir, "gateway.sock");

const TEST_REGISTRY = {
  version: 1,
  flags: [
    {
      id: "browser",
      scope: "assistant",
      key: "browser",
      label: "Browser",
      description: "Browser skill",
      defaultEnabled: true,
    },
    {
      id: "email-channel",
      scope: "assistant",
      key: "email-channel",
      label: "Email Channel",
      description: "Email channel integration",
      defaultEnabled: false,
    },
    {
      id: "user-hosted-enabled",
      scope: "macos",
      key: "user-hosted-enabled",
      label: "User Hosted Enabled",
      description: "Enable user-hosted onboarding flow",
      defaultEnabled: false,
    },
  ],
};

beforeEach(() => {
  mkdirSync(protectedDir, { recursive: true });
  writeFileSync(defaultsPath, JSON.stringify(TEST_REGISTRY, null, 2));
  _setRegistryCandidateOverrides([defaultsPath]);
  resetFeatureFlagDefaultsCache();
  clearFeatureFlagStoreCache();
  clearRemoteFeatureFlagStoreCache();
});

afterEach(() => {
  try {
    rmSync(protectedDir, { recursive: true, force: true });
    mkdirSync(protectedDir, { recursive: true });
  } catch {
    // best effort cleanup
  }
  _setRegistryCandidateOverrides(null);
  resetFeatureFlagDefaultsCache();
  clearFeatureFlagStoreCache();
  clearRemoteFeatureFlagStoreCache();
});

const { resetFeatureFlagDefaultsCache, _setRegistryCandidateOverrides } =
  await import("../feature-flag-defaults.js");
const { clearFeatureFlagStoreCache } = await import("../feature-flag-store.js");
const { clearRemoteFeatureFlagStoreCache } =
  await import("../feature-flag-remote-store.js");
const { GatewayIpcServer } = await import("../ipc/server.js");
const { featureFlagRoutes } = await import("../ipc/feature-flag-handlers.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Connect a raw TCP client to the IPC socket, returning a Socket. */
function connectClient(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = createConnection(path, () => resolve(client));
    client.on("error", reject);
  });
}

/** Send a JSON-RPC-style request and wait for the response. */
function sendRequest(
  client: Socket,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ id: string; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = randomBytes(4).toString("hex");
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        client.off("data", onData);
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    };

    client.on("data", onData);
    const msg = JSON.stringify({ id, method, params });
    client.write(msg + "\n");
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IPC feature flag routes", () => {
  let server: InstanceType<typeof GatewayIpcServer>;
  let client: Socket;

  beforeEach(async () => {
    // Clean stale socket
    if (existsSync(socketPath)) {
      rmSync(socketPath);
    }
  });

  afterEach(() => {
    client?.destroy();
    server?.stop();
  });

  /** Helper to start server and connect client. */
  async function startServerAndConnect(): Promise<void> {
    server = new GatewayIpcServer([...featureFlagRoutes]);
    // Override socket path for testing
    // Access private field via cast for test isolation
    (server as unknown as { socketPath: string }).socketPath = socketPath;
    server.start();

    // Wait briefly for the server to start listening
    await new Promise((resolve) => setTimeout(resolve, 50));
    client = await connectClient(socketPath);
  }

  test("get_feature_flags returns all flags with defaults when no persisted file", async () => {
    // No persisted file
    if (existsSync(featureFlagStorePath)) {
      rmSync(featureFlagStorePath);
    }

    await startServerAndConnect();
    const res = await sendRequest(client, "get_feature_flags");

    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();

    const flags = res.result as Record<string, boolean>;
    // browser defaults to true, email-channel defaults to false
    expect(flags["browser"]).toBe(true);
    expect(flags["email-channel"]).toBe(false);
  });

  test("get_feature_flags merges persisted values over defaults", async () => {
    writeFileSync(
      featureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: { browser: false },
      }),
    );
    clearFeatureFlagStoreCache();

    await startServerAndConnect();
    const res = await sendRequest(client, "get_feature_flags");

    expect(res.error).toBeUndefined();
    const flags = res.result as Record<string, boolean>;
    expect(flags["browser"]).toBe(false); // overridden from default true
    expect(flags["email-channel"]).toBe(false); // still default
  });

  test("get_feature_flags merges remote values when no local override", async () => {
    writeFileSync(
      remoteFeatureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: { "email-channel": true },
      }),
    );
    clearRemoteFeatureFlagStoreCache();

    // No local override
    if (existsSync(featureFlagStorePath)) {
      rmSync(featureFlagStorePath);
    }
    clearFeatureFlagStoreCache();

    await startServerAndConnect();
    const res = await sendRequest(client, "get_feature_flags");

    expect(res.error).toBeUndefined();
    const flags = res.result as Record<string, boolean>;
    expect(flags["email-channel"]).toBe(true); // remote overrides default
  });

  test("get_feature_flag returns value for a known flag", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "get_feature_flag", {
      flag: "browser",
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toBe(true);
  });

  test("get_feature_flag returns null for unknown flag", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "get_feature_flag", {
      flag: "nonexistent-flag",
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();
  });

  test("get_feature_flag validates params with Zod schema", async () => {
    await startServerAndConnect();
    // Missing required 'flag' param — should fail Zod validation
    const res = await sendRequest(client, "get_feature_flag", {});

    expect(res.error).toBeDefined();
    expect(res.error).toContain("Invalid params");
  });

  test("get_feature_flag rejects non-string flag param via Zod", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "get_feature_flag", {
      flag: 123 as unknown as string,
    });

    expect(res.error).toBeDefined();
    expect(res.error).toContain("Invalid params");
  });

  test("unknown method returns error", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "nonexistent_method");

    expect(res.error).toBeDefined();
    expect(res.error).toContain("Unknown method");
  });
});
