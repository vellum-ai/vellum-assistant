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

// Stub electron-log. `warn` is a tracked mock so tests can assert the
// router doesn't log for expected firehose traffic.
const mockLogWarn = mock((..._args: unknown[]) => {});
mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: mockLogWarn,
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

// Stub the presence monitor, capturing the reporter the router installs so
// tests can drive reports without a real powerMonitor or poll interval.
type PresenceState = import("./presence").PresenceState;
let presenceReporter: ((state: PresenceState) => void) | null = null;
const mockPresenceTeardown = mock(() => {});
const mockInstallPresenceMonitor = mock(
  (onReport: (state: PresenceState) => void) => {
    presenceReporter = onReport;
    return mockPresenceTeardown;
  },
);
mock.module("./presence", () => ({
  installPresenceMonitor: mockInstallPresenceMonitor,
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

type Connection = NonNullable<ReturnType<typeof __testing.connections.get>>;

/**
 * Register a connection whose poster records the presence states it receives.
 * `opts` is read on every post, so a test holding the object can flip a
 * connection between healthy and unreachable mid-run: `reject` stands in for
 * a throw, `ok: false` for the non-2xx that postJson folds into `false`.
 */
function addPresenceConnection(
  assistantId: string,
  opts: { reject?: boolean; ok?: boolean } = {},
): PresenceState[] {
  const received: PresenceState[] = [];
  const poster = {
    postPresence: async ({ state }: { state: PresenceState }) => {
      if (opts.reject) {
        throw new Error("daemon unreachable");
      }
      if (opts.ok === false) {
        return false;
      }
      received.push(state);
      return true;
    },
  };
  __testing.connections.set(assistantId, {
    sse: { disconnect: () => {} },
    poster,
    fingerprint: `test:${assistantId}`,
  } as unknown as Connection);
  return received;
}

/**
 * Route presence POSTs into a captured list, leaving every other request
 * (the gateway token exchange) on its normal mock.
 */
function capturePresencePosts(): { url: string; body: string }[] {
  const posts: { url: string; body: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/clients/presence")) {
      posts.push({ url, body: String(init?.body) });
      return new Response("ok");
    }
    return mockGatewayTokenFetch(input);
  }) as typeof globalThis.fetch;
  return posts;
}

/** A lockfile with one local and one cloud assistant. */
const MIXED_LOCKFILE: Lockfile = {
  assistants: [
    { assistantId: "local-1", cloud: "local", resources: { gatewayPort: 9001, daemonPort: 9002 } },
    { assistantId: "cloud-1", cloud: "vellum", runtimeUrl: "https://platform.vellum.ai" },
  ],
  activeAssistant: "local-1",
};

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
    presenceReporter = null;
    mockInstallPresenceMonitor.mockClear();
    mockPresenceTeardown.mockClear();
  });

  // -- Local lifecycle ----------------------------------------------------

  describe("local lifecycle", () => {
    test("connects when an assistant with a gatewayPort appears", async () => {
      installHostProxyBridge(fakeCliResolver);

      const lockfile: Lockfile = {
        assistants: [
          {
            assistantId: "a1",
            cloud: "local",
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
          { assistantId: "a1", cloud: "local", resources: { gatewayPort: 9001, daemonPort: 9002 } },
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
        assistants: [{ assistantId: "no-resources", cloud: "local" }],
        activeAssistant: null,
      });
      await flush();

      expect(__testing.connections.has("no-resources")).toBe(false);
    });

    test("does not duplicate connections on repeated lockfile updates", async () => {
      installHostProxyBridge(fakeCliResolver);

      const lockfile: Lockfile = {
        assistants: [
          { assistantId: "a1", cloud: "local", resources: { gatewayPort: 9001, daemonPort: 9002 } },
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
          { assistantId: "a1", cloud: "local", resources: { gatewayPort: 9001, daemonPort: 9002 } },
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
          { assistantId: "a1", cloud: "local", resources: { gatewayPort: 9001, daemonPort: 9002 } },
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
          { assistantId: "local-1", cloud: "local", resources: { gatewayPort: 9001, daemonPort: 9002 } },
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

    test("drops non-host firehose events silently (no warn spam)", () => {
      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () => new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      mockLogWarn.mockClear();
      // /v1/events is the full assistant-event firehose. These are the
      // high-volume streaming/tool events this connection ignores — none
      // should warn, or the log fills with tens of thousands of lines.
      for (const type of [
        "assistant_thinking_delta",
        "assistant_text_delta",
        "tool_output_chunk",
        "message_complete",
        "sync_changed",
      ]) {
        __testing.dispatchMessage({ type }, poster);
      }

      expect(mockLogWarn).not.toHaveBeenCalled();
    });

    test("warns on a host_*-shaped type it cannot route", () => {
      const poster = new HostProxyPoster({
        endpointBase: "http://127.0.0.1:9000/v1",
        authHeaders: () => ({ Authorization: "Bearer t" }),
        fetch: (async () => new Response("ok")) as unknown as typeof globalThis.fetch,
      });

      mockLogWarn.mockClear();
      __testing.dispatchMessage({ type: "host_teleport_request" }, poster);

      expect(mockLogWarn).toHaveBeenCalledTimes(1);
    });
  });

  // -- Presence reporting --------------------------------------------------

  describe("presence reporting", () => {
    test("installs the monitor even with no assistants connected", () => {
      installHostProxyBridge(fakeCliResolver);

      expect(mockInstallPresenceMonitor).toHaveBeenCalledTimes(1);
      expect(presenceReporter).not.toBeNull();
      expect(__testing.connections.size).toBe(0);
      expect(() => presenceReporter?.("away")).not.toThrow();
    });

    test("posts presence to every connected assistant", async () => {
      const presencePosts = capturePresencePosts();

      installHostProxyBridge(fakeCliResolver);
      lockfileListener?.(MIXED_LOCKFILE);
      await flush();

      presenceReporter?.("idle");
      await flush();

      expect(presencePosts.map((post) => post.url).sort()).toEqual([
        "http://127.0.0.1:9001/v1/clients/presence",
        "https://platform.vellum.ai/v1/assistants/cloud-1/clients/presence",
      ]);
      expect(JSON.parse(presencePosts[0]!.body)).toEqual({ state: "idle" });
    });

    test("seeds an assistant that connects after the last report", async () => {
      const presencePosts = capturePresencePosts();

      installHostProxyBridge(fakeCliResolver);
      presenceReporter?.("idle");
      await flush();
      // Nothing was connected when the report fired.
      expect(presencePosts).toEqual([]);

      lockfileListener?.(MIXED_LOCKFILE);
      await flush();

      // Both are told the cached state as they join rather than waiting out
      // the next poll tick. The local one connects asynchronously, so it is
      // the case the install-time report cannot reach.
      expect(presencePosts.map((post) => post.url).sort()).toEqual([
        "http://127.0.0.1:9001/v1/clients/presence",
        "https://platform.vellum.ai/v1/assistants/cloud-1/clients/presence",
      ]);
      expect(JSON.parse(presencePosts[0]!.body)).toEqual({ state: "idle" });
    });

    test("sends nothing to a new connection before any report", async () => {
      const presencePosts = capturePresencePosts();

      installHostProxyBridge(fakeCliResolver);
      lockfileListener?.(MIXED_LOCKFILE);
      await flush();

      // No observed state means no claim about presence, which is the
      // fail-open direction: the daemon lets the push through.
      expect(presencePosts).toEqual([]);
    });

    test("a second install stops the previous monitor", () => {
      installHostProxyBridge(fakeCliResolver);
      const teardown = installHostProxyBridge(fakeCliResolver);

      expect(mockInstallPresenceMonitor).toHaveBeenCalledTimes(2);
      expect(mockPresenceTeardown).toHaveBeenCalledTimes(1);

      teardown();
      expect(mockPresenceTeardown).toHaveBeenCalledTimes(2);
    });

    test("keeps reporting to siblings when one poster rejects", async () => {
      installHostProxyBridge(fakeCliResolver);
      const unreachable = addPresenceConnection("a1", { reject: true });
      const first = addPresenceConnection("a2");
      const second = addPresenceConnection("a3");

      expect(() => presenceReporter?.("active")).not.toThrow();
      await flush();

      expect(unreachable).toEqual([]);
      expect(first).toEqual(["active"]);
      expect(second).toEqual(["active"]);
    });

    test("posts every report, including repeats of the same state", async () => {
      installHostProxyBridge(fakeCliResolver);
      const received = addPresenceConnection("a1");

      presenceReporter?.("active");
      presenceReporter?.("active");
      presenceReporter?.("active");
      await flush();

      expect(received).toEqual(["active", "active", "active"]);
    });

    test("warns once for a run of failing posts, not once per report", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon = { reject: true };
      addPresenceConnection("a1", daemon);

      mockLogWarn.mockClear();
      presenceReporter?.("active");
      await flush();
      presenceReporter?.("active");
      await flush();
      presenceReporter?.("idle");
      await flush();

      expect(mockLogWarn).toHaveBeenCalledTimes(1);

      // A success re-arms the warning, so the next outage is visible.
      daemon.reject = false;
      presenceReporter?.("active");
      await flush();
      daemon.reject = true;
      presenceReporter?.("away");
      await flush();

      expect(mockLogWarn).toHaveBeenCalledTimes(2);
    });

    test("warns when a post is rejected without throwing", async () => {
      installHostProxyBridge(fakeCliResolver);
      addPresenceConnection("a1", { ok: false });

      mockLogWarn.mockClear();
      presenceReporter?.("active");
      await flush();
      presenceReporter?.("active");
      await flush();

      expect(mockLogWarn).toHaveBeenCalledTimes(1);
    });

    test("a failing assistant does not silence its siblings", async () => {
      installHostProxyBridge(fakeCliResolver);
      addPresenceConnection("a1", { reject: true });
      addPresenceConnection("a2", { ok: false });

      mockLogWarn.mockClear();
      presenceReporter?.("active");
      await flush();

      expect(mockLogWarn).toHaveBeenCalledTimes(2);
    });

    test("bridge teardown stops presence reporting", async () => {
      const teardown = installHostProxyBridge(fakeCliResolver);
      const received = addPresenceConnection("a1");

      teardown();
      expect(mockPresenceTeardown).toHaveBeenCalledTimes(1);

      presenceReporter?.("active");
      await flush();
      expect(received).toEqual([]);
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
