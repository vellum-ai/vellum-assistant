import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must precede imports) ───────────────────────────────────────

// Track captured callbacks and deferred code promises for each McpOAuthProvider
// instance so tests can drive the flow.
let capturedOnAuthorizationUrl: ((url: string) => void) | undefined;
let deferredCodeResolve: ((code: string) => void) | undefined;
let deferredCodeReject: ((err: Error) => void) | undefined;

const mockInvalidateCredentials = mock(async () => {});
const mockStartCallbackServer = mock(async () => {
  const codePromise = new Promise<string>((resolve, reject) => {
    deferredCodeResolve = resolve;
    deferredCodeReject = reject;
  });
  return { codePromise };
});
const mockStopCallbackServer = mock(() => {});

mock.module("../mcp-oauth-provider.js", () => ({
  McpOAuthProvider: class {
    constructor(
      _serverId: string,
      _serverUrl: string,
      _interactive: boolean,
      _callbackTransport: string,
      options: { onAuthorizationUrl?: (url: string) => void } = {},
    ) {
      capturedOnAuthorizationUrl = options.onAuthorizationUrl;
    }
    invalidateCredentials = mockInvalidateCredentials;
    startCallbackServer = mockStartCallbackServer;
    stopCallbackServer = mockStopCallbackServer;
  },
}));

const mockSetMcpAuthPending = mock(
  (_serverId: string, _authUrl: string, _attemptId: string) => {},
);
// Default behavior: pretend the attempt still owns the slot (return true),
// so completion writes are applied unless a test overrides this.
const mockSetMcpAuthComplete = mock(
  (_serverId: string, _attemptId: string): boolean => true,
);
const mockSetMcpAuthError = mock(
  (_serverId: string, _error: string, _attemptId: string): boolean => true,
);

mock.module("../mcp-auth-state.js", () => ({
  setMcpAuthPending: (...args: unknown[]) =>
    mockSetMcpAuthPending(...(args as [string, string, string])),
  setMcpAuthComplete: (...args: unknown[]) =>
    mockSetMcpAuthComplete(...(args as [string, string])),
  setMcpAuthError: (...args: unknown[]) =>
    mockSetMcpAuthError(...(args as [string, string, string])),
}));

const mockReloadMcpServers = mock(async () => ({
  ok: true,
  reloaded: 0,
  servers: [],
}));

mock.module("../../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: () => mockReloadMcpServers(),
}));

mock.module("../../config/env-registry.js", () => ({
  getIsContainerized: () => false,
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Create a fake UnauthorizedError class that the orchestrator's instanceof check
// will recognize (since we're also mocking the auth module).
class FakeUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: FakeUnauthorizedError,
}));

const mockFinishAuth = mock(async (_code: string) => {});
let mockConnectCallCount = 0;

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {
      mockConnectCallCount++;
      // Every connect fires onAuthorizationUrl and throws UnauthorizedError —
      // the orchestrator never calls connect() a second time after finishAuth.
      if (capturedOnAuthorizationUrl) {
        capturedOnAuthorizationUrl("https://auth.example.com/oauth");
      }
      throw new FakeUnauthorizedError("unauthorized");
    }
    async close() {}
  },
}));

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    constructor(_url: URL, _opts: unknown) {}
    finishAuth = mockFinishAuth;
  },
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(_url: URL, _opts: unknown) {}
    finishAuth = mockFinishAuth;
  },
}));

// ── Import SUT after mocks ─────────────────────────────────────────────────────

const { orchestrateMcpOAuthConnect } =
  await import("../mcp-auth-orchestrator.js");

// ── Helpers ────────────────────────────────────────────────────────────────────

function resetMocks() {
  capturedOnAuthorizationUrl = undefined;
  deferredCodeResolve = undefined;
  deferredCodeReject = undefined;
  mockInvalidateCredentials.mockClear();
  mockStartCallbackServer.mockClear();
  mockStopCallbackServer.mockClear();
  mockSetMcpAuthPending.mockClear();
  mockSetMcpAuthComplete.mockClear();
  mockSetMcpAuthError.mockClear();
  mockReloadMcpServers.mockClear();
  mockFinishAuth.mockClear();
  // Reset complete/error mocks to default "applied=true" behavior; tests
  // that exercise the superseded branch override these in-test.
  mockSetMcpAuthComplete.mockImplementation(() => true);
  mockSetMcpAuthError.mockImplementation(() => true);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("orchestrateMcpOAuthConnect", () => {
  beforeEach(() => {
    resetMocks();
    mockConnectCallCount = 0;
  });

  afterEach(() => {
    resetMocks();
    mockConnectCallCount = 0;
  });

  test("happy path — returns auth_url and sets state to pending", async () => {
    const result = await orchestrateMcpOAuthConnect({
      serverId: "test-server",
      transport: { url: "https://example.com", type: "sse" },
    });

    expect(result.auth_url).toBe("https://auth.example.com/oauth");
    expect(mockSetMcpAuthPending.mock.calls[0]).toEqual([
      "test-server",
      "https://auth.example.com/oauth",
      expect.any(String) as unknown as string, // attemptId UUID
    ]);
    // Sanity-check the attemptId looks UUID-shaped
    expect(mockSetMcpAuthPending.mock.calls[0][2]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result).toBeDefined();
  });

  test("tail completion — codePromise resolves → state goes to complete", async () => {
    await orchestrateMcpOAuthConnect({
      serverId: "test-server",
      transport: { url: "https://example.com", type: "sse" },
    });

    // Resolve the code to trigger the background tail
    deferredCodeResolve!("auth-code-123");

    // Wait for fire-and-forget tail to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockFinishAuth).toHaveBeenCalledWith("auth-code-123");
    // The orchestrator calls connect() exactly once (the initial attempt that triggers
    // UnauthorizedError). It does NOT reconnect after finishAuth to avoid the
    // "already started" error thrown by SSE/StreamableHTTP transports.
    expect(mockConnectCallCount).toBe(1);
    expect(mockSetMcpAuthComplete).toHaveBeenCalledWith(
      "test-server",
      expect.any(String) as unknown as string,
    );
    // Daemon-side reload should be triggered after a successful completion.
    expect(mockReloadMcpServers).toHaveBeenCalled();
  });

  test("transport.finishAuth rejects → state goes to error", async () => {
    mockFinishAuth.mockImplementationOnce(async () => {
      throw new Error("exchange failed");
    });

    await orchestrateMcpOAuthConnect({
      serverId: "test-server",
      transport: { url: "https://example.com", type: "sse" },
    });

    deferredCodeResolve!("auth-code-456");

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockSetMcpAuthError).toHaveBeenCalledWith(
      "test-server",
      "exchange failed",
      expect.any(String) as unknown as string,
    );
    expect(mockSetMcpAuthComplete).not.toHaveBeenCalled();
  });

  test("codePromise rejects (timeout/user deny) → state goes to error", async () => {
    await orchestrateMcpOAuthConnect({
      serverId: "test-server",
      transport: { url: "https://example.com", type: "sse" },
    });

    deferredCodeReject!(new Error("MCP OAuth callback timed out"));

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockSetMcpAuthError).toHaveBeenCalledWith(
      "test-server",
      "MCP OAuth callback timed out",
      expect.any(String) as unknown as string,
    );
    expect(mockSetMcpAuthComplete).not.toHaveBeenCalled();
  });

  test("re-start for same serverId while previous is pending → new state overwrites with a fresh attemptId", async () => {
    await orchestrateMcpOAuthConnect({
      serverId: "srv",
      transport: { url: "https://example.com", type: "sse" },
    });

    await orchestrateMcpOAuthConnect({
      serverId: "srv",
      transport: { url: "https://example.com", type: "sse" },
    });

    expect(mockSetMcpAuthPending.mock.calls).toHaveLength(2);
    expect(mockSetMcpAuthPending.mock.calls[0][0]).toBe("srv");
    expect(mockSetMcpAuthPending.mock.calls[1][0]).toBe("srv");
    // Each attempt gets a distinct UUID so superseded tails can be detected.
    const firstAttemptId = mockSetMcpAuthPending.mock.calls[0][2];
    const secondAttemptId = mockSetMcpAuthPending.mock.calls[1][2];
    expect(firstAttemptId).not.toBe(secondAttemptId);
  });

  test("supersede — when setMcpAuthComplete returns false, daemon-side reload is NOT triggered", async () => {
    // Simulate a newer attempt having taken the slot: completion writes
    // for the older attempt should be skipped, and reload should not fire.
    mockSetMcpAuthComplete.mockImplementation(() => false);

    await orchestrateMcpOAuthConnect({
      serverId: "test-server",
      transport: { url: "https://example.com", type: "sse" },
    });

    deferredCodeResolve!("auth-code-superseded");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // The set was attempted but returned false, so no reload should happen
    expect(mockSetMcpAuthComplete).toHaveBeenCalled();
    expect(mockReloadMcpServers).not.toHaveBeenCalled();
  });

  test("reload failure after completion is logged but does not corrupt success state", async () => {
    mockReloadMcpServers.mockImplementation(async () => {
      throw new Error("reload boom");
    });

    await orchestrateMcpOAuthConnect({
      serverId: "test-server",
      transport: { url: "https://example.com", type: "sse" },
    });

    deferredCodeResolve!("auth-code-789");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Completion was applied even though reload threw — the polling CLI
    // still observes status=complete.
    expect(mockSetMcpAuthComplete).toHaveBeenCalled();
    expect(mockSetMcpAuthError).not.toHaveBeenCalled();
    expect(mockReloadMcpServers).toHaveBeenCalled();
  });
});
