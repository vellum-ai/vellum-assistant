import { afterEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Stubs — must precede the router import
// ---------------------------------------------------------------------------

const MOCK_DEVICE_ID = "test-device-00000000-0000-0000-0000-000000000000";
mock.module("./device-id", () => ({
  getDeviceId: () => MOCK_DEVICE_ID,
  resetDeviceIdCache: () => {},
}));

const mockGetGuardianAccessToken = mock(
  async (): Promise<{ ok: true; accessToken: string } | { ok: false; status: number; error: string }> =>
    ({ ok: true, accessToken: "test-token" }),
);
mock.module("@vellumai/local-mode", () => ({
  getGuardianAccessToken: mockGetGuardianAccessToken,
  resolveConfigDir: () => "/tmp/test-config",
}));

// Minimal lockfile-watcher stub — capture the listener
let lockfileListener: ((lockfile: import("@vellumai/local-mode/contract").Lockfile) => void) | null = null;
mock.module("./lockfile-watcher", () => ({
  onLockfileChange: (listener: typeof lockfileListener) => {
    lockfileListener = listener;
    return () => { lockfileListener = null; };
  },
  getWatchedLockfile: () => ({ assistants: [], activeAssistant: null }),
}));

// Stub electron-log
mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      initialize: noop,
      transports: { file: { maxSize: 0, fileName: "", format: "", getFile: () => ({ path: "" }) } },
    },
  };
});

// Stub session-token-store
let mockSessionToken: string | null = "test-session-token";
mock.module("./session-token-store", () => ({
  getSessionToken: () => mockSessionToken,
}));

const { HostProxySseClient } = await import("./host-proxy-sse");
const { HostProxyPoster } = await import("./host-proxy-poster");
const {
  installHostProxyBridge,
  setExecutor,
  removeExecutor,
  __testing,
} = await import("./host-proxy-router");

type Lockfile = import("@vellumai/local-mode/contract").Lockfile;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeCliResolver = async () => ({ command: "echo", baseArgs: [] });

async function flush(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Mock globalThis.fetch for the /auth/token exchange (local gateway). Cloud
// connections resolve their org from the lockfile, so they make no fetch here.
const originalFetch = globalThis.fetch;
const mockGatewayTokenFetch = async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/auth/token")) {
    return new Response(JSON.stringify({ token: "gateway-jwt", expiresAt: Date.now() + 60_000 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("ok");
};
globalThis.fetch = mockGatewayTokenFetch as typeof globalThis.fetch;

/** Create a poster that captures the first POST body for assertions. */
function capturingPoster(): { poster: InstanceType<typeof HostProxyPoster>; body: () => Record<string, unknown> | null } {
  let postedBody: Record<string, unknown> | null = null;
  const fakeFetch = async (_url: unknown, init?: RequestInit) => {
    postedBody = JSON.parse(init?.body as string);
    return new Response("ok");
  };
  const poster = new HostProxyPoster({
    endpointBase: "http://127.0.0.1:9000/v1",
    authHeaders: () => ({ Authorization: "Bearer t" }),
    fetch: fakeFetch as typeof globalThis.fetch,
  });
  return { poster, body: () => postedBody };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("host-proxy-router", () => {
  afterEach(() => {
    __testing.reset();
    lockfileListener = null;
    mockGetGuardianAccessToken.mockReset();
    mockGetGuardianAccessToken.mockImplementation(
      async () => ({ ok: true, accessToken: "test-token" }),
    );
    mockSessionToken = "test-session-token";
    globalThis.fetch = mockGatewayTokenFetch as typeof globalThis.fetch;
  });

  // -- Local lifecycle ----------------------------------------------------

  describe("local lifecycle", () => {
    test("connects when an assistant with a gatewayPort appears", async () => {
      installHostProxyBridge(fakeCliResolver);

      const lockfile: Lockfile = {
        assistants: [
          {
            assistantId: "a1",
            resources: { gatewayPort: 9001, daemonPort: 9002 },
          },
        ],
        activeAssistant: "a1",
      };
      lockfileListener?.(lockfile);
      await flush();

      expect(__testing.connections.has("a1")).toBe(true);
      const conn = __testing.connections.get("a1")!;
      expect(conn.sse).toBeInstanceOf(HostProxySseClient);
      expect(conn.poster).toBeInstanceOf(HostProxyPoster);
      expect(conn.fingerprint).toBe("local:9001");
    });

    test("disconnects when an assistant is retired", async () => {
      installHostProxyBridge(fakeCliResolver);

      // Appear
      lockfileListener?.({
        assistants: [
          { assistantId: "a1", resources: { gatewayPort: 9001, daemonPort: 9002 } },
        ],
        activeAssistant: "a1",
      });
      await flush();
      expect(__testing.connections.has("a1")).toBe(true);

      // Retire
      lockfileListener?.({ assistants: [], activeAssistant: null });
      await flush();
      expect(__testing.connections.has("a1")).toBe(false);
    });

    test("ignores assistants without resources or runtimeUrl", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [{ assistantId: "no-resources" }],
        activeAssistant: null,
      });
      await flush();

      expect(__testing.connections.has("no-resources")).toBe(false);
    });

    test("does not duplicate connections on repeated lockfile updates", async () => {
      installHostProxyBridge(fakeCliResolver);

      const lockfile: Lockfile = {
        assistants: [
          { assistantId: "a1", resources: { gatewayPort: 9001, daemonPort: 9002 } },
        ],
        activeAssistant: "a1",
      };

      lockfileListener?.(lockfile);
      await flush();
      const firstSse = __testing.connections.get("a1")!.sse;

      lockfileListener?.(lockfile);
      await flush();
      // Same instance — no duplicate connection
      expect(__testing.connections.get("a1")!.sse).toBe(firstSse);
    });

    test("teardown disconnects all and clears listener", async () => {
      const teardown = installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "a1", resources: { gatewayPort: 9001, daemonPort: 9002 } },
        ],
        activeAssistant: "a1",
      });
      await flush();
      expect(__testing.connections.size).toBe(1);

      teardown();
      expect(__testing.connections.size).toBe(0);
      expect(lockfileListener).toBeNull();
    });

    test("does not connect when guardian token fetch fails", async () => {
      mockGetGuardianAccessToken.mockImplementation(
        async () => ({ ok: false, status: 401, error: "expired" }),
      );
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "a1", resources: { gatewayPort: 9001, daemonPort: 9002 } },
        ],
        activeAssistant: "a1",
      });
      await flush();

      expect(__testing.connections.has("a1")).toBe(false);
    });
  });

  // -- Cloud lifecycle ----------------------------------------------------

  describe("cloud lifecycle", () => {
    test("connects when a cloud assistant with runtimeUrl appears", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();

      expect(__testing.connections.has("cloud-1")).toBe(true);
      const conn = __testing.connections.get("cloud-1")!;
      expect(conn.sse).toBeInstanceOf(HostProxySseClient);
      expect(conn.poster).toBeInstanceOf(HostProxyPoster);
      expect(conn.fingerprint).toBe("cloud:https://platform.vellum.ai:");
    });

    test("stamps organizationId from the lockfile into the fingerprint", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
            organizationId: "org-from-lockfile",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();

      expect(__testing.connections.get("cloud-1")!.fingerprint).toBe(
        "cloud:https://platform.vellum.ai:org-from-lockfile",
      );
    });

    test("reconnects cloud assistant when organizationId changes", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
            organizationId: "org-a",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();
      const firstSse = __testing.connections.get("cloud-1")!.sse;

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
            organizationId: "org-b",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();

      expect(__testing.connections.get("cloud-1")!.sse).not.toBe(firstSse);
      expect(__testing.connections.get("cloud-1")!.fingerprint).toBe(
        "cloud:https://platform.vellum.ai:org-b",
      );
    });

    test("skips cloud assistant when no session token is available", async () => {
      mockSessionToken = null;
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();

      expect(__testing.connections.has("cloud-1")).toBe(false);
    });

    test("disconnects cloud assistant when removed from lockfile", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();
      expect(__testing.connections.has("cloud-1")).toBe(true);

      lockfileListener?.({ assistants: [], activeAssistant: null });
      await flush();
      expect(__testing.connections.has("cloud-1")).toBe(false);
    });

    test("handles mixed local and cloud assistants", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "local-1", resources: { gatewayPort: 9001, daemonPort: 9002 } },
          { assistantId: "cloud-1", cloud: "vellum", runtimeUrl: "https://platform.vellum.ai" },
        ],
        activeAssistant: "local-1",
      });
      await flush();

      expect(__testing.connections.has("local-1")).toBe(true);
      expect(__testing.connections.has("cloud-1")).toBe(true);
      expect(__testing.connections.get("local-1")!.fingerprint).toBe("local:9001");
      expect(__testing.connections.get("cloud-1")!.fingerprint).toBe("cloud:https://platform.vellum.ai:");
    });

    test("reconnects cloud assistant when runtimeUrl changes", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "cloud-1", cloud: "vellum", runtimeUrl: "https://old.vellum.ai" },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();
      const firstSse = __testing.connections.get("cloud-1")!.sse;

      lockfileListener?.({
        assistants: [
          { assistantId: "cloud-1", cloud: "vellum", runtimeUrl: "https://new.vellum.ai" },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();

      expect(__testing.connections.has("cloud-1")).toBe(true);
      expect(__testing.connections.get("cloud-1")!.sse).not.toBe(firstSse);
      expect(__testing.connections.get("cloud-1")!.fingerprint).toBe("cloud:https://new.vellum.ai:");
    });

    test("ignores non-vellum cloud assistants without resources", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "custom-1", cloud: "custom", runtimeUrl: "https://my-server.com" },
        ],
        activeAssistant: "custom-1",
      });
      await flush();

      expect(__testing.connections.has("custom-1")).toBe(false);
    });

    test("does not duplicate cloud connections on repeated lockfile updates", async () => {
      installHostProxyBridge(fakeCliResolver);

      const lockfile: Lockfile = {
        assistants: [
          { assistantId: "cloud-1", cloud: "vellum", runtimeUrl: "https://platform.vellum.ai" },
        ],
        activeAssistant: "cloud-1",
      };

      lockfileListener?.(lockfile);
      await flush();
      const firstSse = __testing.connections.get("cloud-1")!.sse;

      lockfileListener?.(lockfile);
      await flush();
      expect(__testing.connections.get("cloud-1")!.sse).toBe(firstSse);
    });
  });

  // -- Message dispatch ----------------------------------------------------

  describe("message dispatch", () => {
    test("routes request to registered executor", () => {
      const handled: string[] = [];
      setExecutor("host_bash", {
        handleRequest: (msg) => { handled.push(`req:${msg.requestId}`); },
        handleCancel: (msg) => { handled.push(`cancel:${msg.requestId}`); },
      });

      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () => new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      __testing.dispatchMessage(
        { type: "host_bash_request", requestId: "r1" },
        poster,
      );
      __testing.dispatchMessage(
        { type: "host_bash_cancel", requestId: "r2" },
        poster,
      );

      expect(handled).toEqual(["req:r1", "cancel:r2"]);
      removeExecutor("host_bash");
    });

    test("routes file messages to file executor", () => {
      const handled: string[] = [];
      setExecutor("host_file", {
        handleRequest: (msg) => { handled.push(`req:${msg.requestId}`); },
        handleCancel: (msg) => { handled.push(`cancel:${msg.requestId}`); },
      });

      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () => new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      __testing.dispatchMessage(
        { type: "host_file_request", requestId: "f1" },
        poster,
      );

      expect(handled).toEqual(["req:f1"]);
      removeExecutor("host_file");
    });

    test("posts stub error for unimplemented bash executor", async () => {
      const { poster, body } = capturingPoster();
      __testing.dispatchMessage({ type: "host_bash_request", requestId: "r1" }, poster);
      await flush();

      expect(body()).not.toBeNull();
      expect(body()!.requestId).toBe("r1");
      expect(body()!.stderr).toBe("Executor not yet implemented");
      expect(body()!.exitCode).toBe(1);
    });

    test("posts stub error for unimplemented file executor", async () => {
      const { poster, body } = capturingPoster();
      __testing.dispatchMessage({ type: "host_file_request", requestId: "f1" }, poster);
      await flush();

      expect(body()!.requestId).toBe("f1");
      expect(body()!.isError).toBe(true);
    });

    test("posts stub error for unimplemented transfer executor", async () => {
      const { poster, body } = capturingPoster();
      __testing.dispatchMessage({ type: "host_transfer_request", requestId: "t1" }, poster);
      await flush();

      expect(body()!.requestId).toBe("t1");
      expect(body()!.isError).toBe(true);
      expect(body()!.errorMessage).toBe("Executor not yet implemented");
    });

    test("posts stub error for unimplemented browser executor", async () => {
      const { poster, body } = capturingPoster();
      __testing.dispatchMessage({ type: "host_browser_request", requestId: "b1" }, poster);
      await flush();

      expect(body()!.requestId).toBe("b1");
      expect(body()!.isError).toBe(true);
    });

    test("ignores unknown message types without crashing", () => {
      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () => new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      // Should not throw
      __testing.dispatchMessage(
        { type: "host_unknown_request", requestId: "u1" },
        poster,
      );
    });
  });

  // -- Executor registry ---------------------------------------------------

  describe("executor registry", () => {
    test("setExecutor and removeExecutor manage the registry", () => {
      const executor = {
        handleRequest: () => {},
        handleCancel: () => {},
      };

      setExecutor("host_bash", executor);
      expect(__testing.executors.has("host_bash")).toBe(true);

      removeExecutor("host_bash");
      expect(__testing.executors.has("host_bash")).toBe(false);
    });
  });
});
