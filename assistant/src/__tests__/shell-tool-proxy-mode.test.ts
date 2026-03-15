import * as realChildProcess from "node:child_process";
import { afterEach, describe, expect, mock, test } from "bun:test";

const originalSpawn = realChildProcess.spawn;

// Track spawn calls to inspect env vars passed to child processes
const spawnCalls: {
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
}[] = [];
const spawnSpy = mock((...args: Parameters<typeof realChildProcess.spawn>) => {
  const opts = args[2] as { env?: Record<string, string> } | undefined;
  spawnCalls.push({
    command: args[0] as string,
    args: args[1] as string[],
    env: opts?.env ? { ...opts.env } : undefined,
  });
  return (originalSpawn as (...a: unknown[]) => unknown)(...args);
});

mock.module("node:child_process", () => ({
  ...realChildProcess,
  spawn: spawnSpy,
}));

const mockConfig = {
  provider: "anthropic",
  model: "test",
  maxTokens: 4096,
  dataDir: "/tmp",
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  sandbox: { enabled: false },
  rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  secretDetection: {
    enabled: true,
    action: "warn" as const,
    entropyThreshold: 4.0,
  },
  auditLog: { retentionDays: 0 },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  saveConfig: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../security/secret-scanner.js", () => ({
  redactSecrets: (s: string) => s,
}));

// Track wrapCommand calls to verify networkMode is forwarded
let wrapCommandCalls: {
  cmd: string;
  workingDir: string;
  config: unknown;
  options: unknown;
}[] = [];

mock.module("../tools/terminal/sandbox.js", () => ({
  wrapCommand: (
    cmd: string,
    workingDir: string,
    config: unknown,
    options?: unknown,
  ) => {
    wrapCommandCalls.push({ cmd, workingDir, config, options });
    return { command: "/bin/sh", args: ["-c", cmd], sandboxed: false };
  },
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp/test-data",
}));

// --- Proxy session mocks ---
let mockActiveSession: { id: string; conversationId: string } | undefined;
let getOrStartSessionCalls: {
  conversationId: string;
  credentialIds: string[];
}[] = [];
let getSessionEnvCalls: string[] = [];

const MOCK_SESSION_ID = "mock-proxy-session-id";
const MOCK_PROXY_PORT = 9876;

mock.module("../tools/network/script-proxy/index.js", () => ({
  getOrStartSession: async (
    conversationId: string,
    credentialIds: string[],
  ) => {
    getOrStartSessionCalls.push({ conversationId, credentialIds });
    if (
      mockActiveSession &&
      mockActiveSession.conversationId === conversationId
    ) {
      return {
        session: {
          id: mockActiveSession.id,
          conversationId,
          credentialIds,
          status: "active",
          createdAt: new Date(),
          port: MOCK_PROXY_PORT,
        },
        created: false,
      };
    }
    return {
      session: {
        id: MOCK_SESSION_ID,
        conversationId,
        credentialIds,
        status: "active",
        createdAt: new Date(),
        port: MOCK_PROXY_PORT,
      },
      created: true,
    };
  },
  getActiveSession: (conversationId: string) => {
    if (
      mockActiveSession &&
      mockActiveSession.conversationId === conversationId
    ) {
      return mockActiveSession;
    }
    return undefined;
  },
  getSessionEnv: (sessionId: string) => {
    getSessionEnvCalls.push(sessionId);
    return {
      HTTP_PROXY: `http://127.0.0.1:${MOCK_PROXY_PORT}`,
      HTTPS_PROXY: `http://127.0.0.1:${MOCK_PROXY_PORT}`,
      NO_PROXY: "localhost,127.0.0.1,::1",
      NODE_EXTRA_CA_CERTS: "/tmp/test-data/proxy-ca/ca.pem",
    };
  },
  ensureLocalCA: async () => {},
  issueLeafCert: async () => ({ cert: "", key: "" }),
  getCAPath: () => "/tmp/test-data/proxy-ca/ca.pem",
  getSessionsForConversation: () => [],
  stopAllSessions: async () => {},
}));

mock.module("../tools/credentials/resolve.js", () => ({
  resolveCredentialRef: (ref: string) => ({ credentialId: ref }),
}));

mock.module("../tools/network/script-proxy/logging.js", () => ({
  buildCredentialRefTrace: (
    rawRefs: string[],
    resolvedIds: string[],
    unresolvedRefs: string[],
  ) => ({ rawRefs, resolvedIds, unresolvedRefs }),
}));

import { shellTool } from "../tools/terminal/shell.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "test-session",
    conversationId: "test-conv",
    trustClass: "guardian",
    ...overrides,
  };
}

afterEach(() => {
  spawnCalls.length = 0;
  wrapCommandCalls = [];
  getOrStartSessionCalls = [];
  getSessionEnvCalls = [];
  mockActiveSession = undefined;
});

describe("shell tool proxy mode", () => {
  test("default mode does not inject proxy env vars", async () => {
    const result = await shellTool.execute(
      { command: "echo hello" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(getOrStartSessionCalls).toHaveLength(0);

    const lastCall = spawnCalls[spawnCalls.length - 1];
    expect(lastCall.env?.HTTP_PROXY).toBeUndefined();
    expect(lastCall.env?.HTTPS_PROXY).toBeUndefined();
  });

  test("network_mode=off does not inject proxy env vars", async () => {
    const result = await shellTool.execute(
      { command: "echo hello", network_mode: "off" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(getOrStartSessionCalls).toHaveLength(0);

    const lastCall = spawnCalls[spawnCalls.length - 1];
    expect(lastCall.env?.HTTP_PROXY).toBeUndefined();
  });

  test("network_mode=proxied creates session and injects proxy env", async () => {
    const result = await shellTool.execute(
      {
        command: "echo proxied",
        network_mode: "proxied",
        credential_ids: ["cred-1"],
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);

    // Session acquired via getOrStartSession
    expect(getOrStartSessionCalls).toHaveLength(1);
    expect(getOrStartSessionCalls[0].conversationId).toBe("test-conv");
    expect(getOrStartSessionCalls[0].credentialIds).toEqual(["cred-1"]);

    // Env injection
    const lastCall = spawnCalls[spawnCalls.length - 1];
    expect(lastCall.env?.HTTP_PROXY).toBe(
      `http://127.0.0.1:${MOCK_PROXY_PORT}`,
    );
    expect(lastCall.env?.HTTPS_PROXY).toBe(
      `http://127.0.0.1:${MOCK_PROXY_PORT}`,
    );
    expect(lastCall.env?.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(lastCall.env?.NODE_EXTRA_CA_CERTS).toBe(
      "/tmp/test-data/proxy-ca/ca.pem",
    );

    // Session is NOT stopped after command — idle timer handles cleanup
    expect(getSessionEnvCalls).toHaveLength(1);
    expect(getSessionEnvCalls[0]).toBe(MOCK_SESSION_ID);
  });

  test("proxied mode reuses existing active session", async () => {
    mockActiveSession = {
      id: "existing-session-id",
      conversationId: "test-conv",
    };

    const result = await shellTool.execute(
      { command: "echo reuse", network_mode: "proxied" },
      makeContext(),
    );

    expect(result.isError).toBe(false);

    // getOrStartSession is still called — it internally returns the existing session
    expect(getOrStartSessionCalls).toHaveLength(1);

    // Should get env from existing session
    expect(getSessionEnvCalls).toHaveLength(1);
    expect(getSessionEnvCalls[0]).toBe("existing-session-id");

    // Should still inject proxy env
    const lastCall = spawnCalls[spawnCalls.length - 1];
    expect(lastCall.env?.HTTP_PROXY).toBeDefined();
  });

  test("safe env vars are preserved alongside proxy vars", async () => {
    const result = await shellTool.execute(
      {
        command: "echo env-merge",
        network_mode: "proxied",
        credential_ids: ["cred-x"],
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);

    const lastCall = spawnCalls[spawnCalls.length - 1];
    // Safe env vars should still be present
    expect(lastCall.env?.PATH).toBeDefined();
    expect(lastCall.env?.HOME).toBeDefined();
    // Proxy vars should also be present
    expect(lastCall.env?.HTTP_PROXY).toBeDefined();
    expect(lastCall.env?.HTTPS_PROXY).toBeDefined();
  });

  test("schema includes network_mode and credential_ids", () => {
    const def = shellTool.getDefinition();
    const props = (def.input_schema as { properties: Record<string, unknown> })
      .properties;
    expect(props.network_mode).toBeDefined();
    expect(props.credential_ids).toBeDefined();
  });

  test('wrapCommand receives { networkMode: "proxied" } when network_mode=proxied', async () => {
    const result = await shellTool.execute(
      { command: "echo proxied-wrap", network_mode: "proxied" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(wrapCommandCalls).toHaveLength(1);
    expect(wrapCommandCalls[0].options).toEqual({ networkMode: "proxied" });
  });

  test('wrapCommand receives { networkMode: "off" } when network_mode is absent', async () => {
    const result = await shellTool.execute(
      { command: "echo default-wrap" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(wrapCommandCalls).toHaveLength(1);
    expect(wrapCommandCalls[0].options).toEqual({ networkMode: "off" });
  });

  test('wrapCommand receives { networkMode: "off" } when network_mode=off', async () => {
    const result = await shellTool.execute(
      { command: "echo off-wrap", network_mode: "off" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(wrapCommandCalls).toHaveLength(1);
    expect(wrapCommandCalls[0].options).toEqual({ networkMode: "off" });
  });
});
