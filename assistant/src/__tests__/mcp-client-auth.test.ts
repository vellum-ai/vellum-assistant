import { describe, expect, jest, mock, test } from "bun:test";

// Mock secure-keys so McpOAuthProvider doesn't try to access the credential store
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: jest.fn().mockResolvedValue(null),
  setSecureKeyAsync: jest.fn().mockResolvedValue(true),
  deleteSecureKeyAsync: jest.fn().mockResolvedValue("deleted"),
}));

mock.module("../config/env-registry.js", () => ({
  getDebugStdoutLogs: () => false,
  getIsContainerized: () => false,
  getIsPlatform: () => false,
  isPlatformRemote: () => false,
  getWorkspaceDirOverride: () => process.env.VELLUM_WORKSPACE_DIR,
  getBackupDirOverride: () => undefined,
  getBackupKeyPathOverride: () => undefined,
  getCpuLimit: () => undefined,
  getMinikubeStorageSize: () => undefined,
  getProfilerRunId: () => undefined,
  getProfilerMode: () => undefined,
  getProfilerMaxBytes: () => undefined,
  getProfilerMaxRuns: () => undefined,
  getProfilerMinFreeMb: () => undefined,
  checkUnrecognizedEnvVars: () => [],
}));

const { McpClient } = await import("../mcp/client.js");
const { McpOAuthProvider } = await import("../mcp/mcp-oauth-provider.js");

/**
 * Mimics the SDK's StreamableHTTPError which has a `.code` property
 * containing the HTTP status code, but doesn't include it in `.message`.
 */
class FakeStreamableHTTPError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(`Streamable HTTP error: ${message}`);
    this.code = code;
  }
}

const httpTransport = {
  type: "streamable-http" as const,
  url: "https://example.com/mcp",
};

describe("McpClient auth error detection", () => {
  test("treats StreamableHTTPError with code 401 as auth error (does not throw)", async () => {
    const client = new McpClient("test-server");

    // Monkey-patch createTransport to throw a 401 StreamableHTTPError
    (client as any).createTransport = () => ({});
    (client as any).client = {
      connect: () => {
        throw new FakeStreamableHTTPError(
          401,
          'Error POSTing to endpoint: {"error":"invalid_token"}',
        );
      },
      close: async () => {},
    };

    // Should NOT throw — auth errors are swallowed, isConnected stays false
    await client.connect(httpTransport);
    expect(client.isConnected).toBe(false);
  });

  test("treats StreamableHTTPError with code 403 as auth error (does not throw)", async () => {
    const client = new McpClient("test-server");

    (client as any).createTransport = () => ({});
    (client as any).client = {
      connect: () => {
        throw new FakeStreamableHTTPError(403, "Forbidden");
      },
      close: async () => {},
    };

    await client.connect(httpTransport);
    expect(client.isConnected).toBe(false);
  });

  test("swallows non-auth StreamableHTTPError (connect never throws)", async () => {
    const client = new McpClient("test-server");

    (client as any).createTransport = () => ({});
    (client as any).client = {
      connect: () => {
        throw new FakeStreamableHTTPError(500, "Internal Server Error");
      },
      close: async () => {},
    };

    // Non-auth errors are logged but never propagated — daemon keeps running
    await client.connect(httpTransport);
    expect(client.isConnected).toBe(false);
  });

  test("treats error message containing 'unauthorized' as auth error", async () => {
    const client = new McpClient("test-server");

    (client as any).createTransport = () => ({});
    (client as any).client = {
      connect: () => {
        throw new Error("unauthorized request");
      },
      close: async () => {},
    };

    await client.connect(httpTransport);
    expect(client.isConnected).toBe(false);
  });

  test("treats SDK fetchToken 'authorizationCode is required' error as auth error", async () => {
    const client = new McpClient("test-server");

    (client as any).createTransport = () => ({});
    (client as any).client = {
      connect: () => {
        throw new Error(
          "Either provider.prepareTokenRequest() or authorizationCode is required",
        );
      },
      close: async () => {},
    };

    await client.connect(httpTransport);
    expect(client.isConnected).toBe(false);
  });
});

describe("McpClient connection lifecycle", () => {
  test("a close during connect cannot restore a stale connected state", async () => {
    const onUnexpectedClose = jest.fn();
    const client = new McpClient("test-server", "workspace", onUnexpectedClose);
    let finishConnect: (() => void) | undefined;
    (client as any).createTransport = () => ({});
    (client as any).client.connect = () =>
      new Promise<void>((resolve) => {
        finishConnect = resolve;
      });

    const connecting = client.connect(httpTransport);
    while (!finishConnect) {
      await Promise.resolve();
    }
    (client as any).client.onclose();
    finishConnect!();
    await connecting;

    expect(client.isConnected).toBe(false);
    expect(client.lastError?.message).toContain("closed during initialization");
    expect(onUnexpectedClose).not.toHaveBeenCalled();
  });

  test("reports an unexpected close after connecting", async () => {
    const onUnexpectedClose = jest.fn();
    const client = new McpClient("test-server", "workspace", onUnexpectedClose);
    (client as any).createTransport = () => ({});
    (client as any).client.connect = async () => {};

    await client.connect(httpTransport);
    (client as any).client.onclose();

    expect(client.isConnected).toBe(false);
    expect(onUnexpectedClose).toHaveBeenCalledTimes(1);
  });

  test("does not report an intentional disconnect as a transport failure", async () => {
    const onUnexpectedClose = jest.fn();
    const client = new McpClient("test-server", "workspace", onUnexpectedClose);
    (client as any).createTransport = () => ({});
    (client as any).client.connect = async () => {};
    (client as any).client.close = async () => {
      (client as any).client.onclose();
    };

    await client.connect(httpTransport);
    await client.disconnect();

    expect(client.isConnected).toBe(false);
    expect(onUnexpectedClose).not.toHaveBeenCalled();
  });
});

describe("McpOAuthProvider redirectUrl", () => {
  test("redirectUrl is undefined until startCallbackServer() is called", () => {
    const nonInteractive = new McpOAuthProvider(
      "test-server",
      "https://example.com/mcp",
      /* interactive */ false,
    );
    expect(nonInteractive.redirectUrl).toBeUndefined();

    const interactive = new McpOAuthProvider(
      "test-server",
      "https://example.com/mcp",
      /* interactive */ true,
    );
    expect(interactive.redirectUrl).toBeUndefined();
  });
});
