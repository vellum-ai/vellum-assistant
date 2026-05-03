import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

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

const mockSetMcpAuthPending = mock((_serverId: string, _authUrl: string) => {});
const mockSetMcpAuthComplete = mock((_serverId: string) => {});
const mockSetMcpAuthError = mock((_serverId: string, _error: string) => {});

mock.module("../mcp-auth-state.js", () => ({
  setMcpAuthPending: (...args: unknown[]) =>
    mockSetMcpAuthPending(...(args as [string, string])),
  setMcpAuthComplete: (...args: unknown[]) =>
    mockSetMcpAuthComplete(...(args as [string])),
  setMcpAuthError: (...args: unknown[]) =>
    mockSetMcpAuthError(...(args as [string, string])),
}));

mock.module("../../config/env-registry.js", () => ({
  getIsPlatform: () => false,
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

const { orchestrateMcpOAuthConnect } = await import(
  "../mcp-auth-orchestrator.js"
);

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
  mockFinishAuth.mockClear();
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
    ]);
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
    expect(mockSetMcpAuthComplete).toHaveBeenCalledWith("test-server");
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
    );
    expect(mockSetMcpAuthComplete).not.toHaveBeenCalled();
  });

  test("re-start for same serverId while previous is pending → new state overwrites", async () => {
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
  });
});
