import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type Socket } from "node:net";
import { testSecurityDir, testWorkspaceDir } from "./test-preload.js";

import { connectClient, sendRequest } from "./helpers/ipc-newline-client.js";

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
      id: "a2a-channel",
      scope: "assistant",
      key: "a2a-channel",
      label: "A2A Channel",
      description: "A2A channel integration",
      defaultEnabled: false,
    },
    {
      id: "user-hosted-enabled",
      scope: "client",
      key: "user-hosted-enabled",
      label: "User Hosted Enabled",
      description: "Enable user-hosted onboarding flow",
      defaultEnabled: false,
    },
    {
      id: "default-model",
      scope: "assistant",
      key: "default-model",
      label: "Default Model",
      description: "Default LLM model identifier",
      defaultEnabled: "claude-sonnet-4-6",
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
  resetEnvOverridesCache();
  delete process.env.VELLUM_FLAG_A2A_CHANNEL;
});

const { resetFeatureFlagDefaultsCache, _setRegistryCandidateOverrides } =
  await import("../feature-flag-defaults.js");
const { clearFeatureFlagStoreCache } = await import("../feature-flag-store.js");
const { clearRemoteFeatureFlagStoreCache } =
  await import("../feature-flag-remote-store.js");
const { resetEnvOverridesCache } =
  await import("../feature-flag-env-overrides.js");
const { GatewayIpcServer } = await import("../ipc/server.js");
const { featureFlagRoutes } = await import("../ipc/feature-flag-handlers.js");

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
    // browser defaults to true, a2a-channel defaults to false
    expect(flags["browser"]).toBe(true);
    expect(flags["a2a-channel"]).toBe(false);
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
    expect(flags["a2a-channel"]).toBe(false); // still default
  });

  test("get_feature_flags merges remote values when no local override", async () => {
    writeFileSync(
      remoteFeatureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: { "a2a-channel": true },
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
    expect(flags["a2a-channel"]).toBe(true); // remote overrides default
  });

  test("get_feature_flags falls back to registry defaults for flags missing from a remote snapshot", async () => {
    writeFileSync(
      remoteFeatureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: { "a2a-channel": true },
      }),
    );
    clearRemoteFeatureFlagStoreCache();

    if (existsSync(featureFlagStorePath)) {
      rmSync(featureFlagStorePath);
    }
    clearFeatureFlagStoreCache();

    await startServerAndConnect();
    const res = await sendRequest(client, "get_feature_flags");

    expect(res.error).toBeUndefined();
    const flags = res.result as Record<string, boolean>;
    expect(flags["a2a-channel"]).toBe(true);
    expect(flags["browser"]).toBe(true);
  });

  test("get_feature_flags includes string flag values", async () => {
    if (existsSync(featureFlagStorePath)) rmSync(featureFlagStorePath);
    clearFeatureFlagStoreCache();

    await startServerAndConnect();
    const res = await sendRequest(client, "get_feature_flags");

    expect(res.error).toBeUndefined();
    const flags = res.result as Record<string, boolean | string>;
    expect(flags["default-model"]).toBe("claude-sonnet-4-6");
  });

  test("get_feature_flag returns string value for string flag", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "get_feature_flag", {
      flag: "default-model",
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toBe("claude-sonnet-4-6");
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

  test("get_feature_flags includes env override values", async () => {
    process.env.VELLUM_FLAG_A2A_CHANNEL = "true";
    resetEnvOverridesCache();

    if (existsSync(featureFlagStorePath)) rmSync(featureFlagStorePath);
    clearFeatureFlagStoreCache();

    await startServerAndConnect();
    const res = await sendRequest(client, "get_feature_flags");

    expect(res.error).toBeUndefined();
    const flags = res.result as Record<string, boolean | string>;
    // a2a-channel defaults to false, but env override sets it to true
    expect(flags["a2a-channel"]).toBe(true);
  });

  test("unknown method returns error", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "nonexistent_method");

    expect(res.error).toBeDefined();
    expect(res.error).toContain("Unknown method");
  });
});
