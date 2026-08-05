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
  async (
    ..._args: unknown[]
  ): Promise<{ ok: true; accessToken: string } | { ok: false; status: number; error: string }> =>
    ({ ok: true, accessToken: "test-token" }),
);
mock.module("@vellumai/local-mode", () => ({
  getGuardianAccessToken: mockGetGuardianAccessToken,
  resolveConfigDir: () => "/tmp/test-config",
  resolveEnvironmentName: () => "test",
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

/**
 * Event-stream responses that stay open, so the SSE clients the router builds
 * report connected the way they do against a live daemon. Presence posting is
 * gated on that, and the seed rides the connected transition.
 */
const openEventStreams: ReadableStreamDefaultController<Uint8Array>[] = [];

function openEventStream(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      openEventStreams.push(controller);
      controller.enqueue(new TextEncoder().encode(": ok\n\n"));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Drop every live stream, which is what a daemon restart looks like. */
function closeEventStreams(): void {
  const controllers = openEventStreams.splice(0, openEventStreams.length);
  for (const controller of controllers) {
    try {
      controller.close();
    } catch {
      // Already closed.
    }
  }
}

// While set, event-stream requests park here, so a test can observe the window
// where connect() has been called but no stream is live yet.
let eventStreamGate: Promise<void> | null = null;
let openEventStreamGate: (() => void) | null = null;

function holdEventStreams(): () => void {
  eventStreamGate = new Promise<void>((resolve) => {
    openEventStreamGate = resolve;
  });
  return releaseEventStreams;
}

/** Let any parked event-stream request through. A no-op if none is held. */
function releaseEventStreams(): void {
  const open = openEventStreamGate;
  eventStreamGate = null;
  openEventStreamGate = null;
  open?.();
}

// Mock globalThis.fetch for the /auth/token exchange (local gateway) and the
// event streams. Cloud connections resolve their org from the lockfile, so
// they make no token fetch here.
const originalFetch = globalThis.fetch;
const mockGatewayTokenFetch = async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/auth/token")) {
    return new Response(JSON.stringify({ token: "gateway-jwt", expiresAt: Date.now() + 60_000 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.endsWith("/events")) {
    if (eventStreamGate) {
      await eventStreamGate;
    }
    return openEventStream();
  }
  return new Response("ok");
};
globalThis.fetch = mockGatewayTokenFetch as typeof globalThis.fetch;

type Connection = NonNullable<ReturnType<typeof __testing.connections.get>>;

/** A stand-in SSE whose connectedness a test can flip mid-run. */
function fakeSse(): { isConnected: boolean; disconnect: () => void } {
  return { isConnected: true, disconnect: () => {} };
}

/**
 * Register a connection whose poster records the presence states it receives.
 * `opts` is read on every post, so a test holding the object can flip a
 * connection between healthy and unreachable mid-run: `reject` stands in for
 * a throw, `ok: false` for the failure postPresence folds every non-2xx,
 * throw, and unrecorded reply into.
 */
function addPresenceConnection(
  assistantId: string,
  opts: {
    reject?: boolean;
    ok?: boolean;
    sse?: ReturnType<typeof fakeSse>;
  } = {},
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
    sse: opts.sse ?? fakeSse(),
    poster,
    fingerprint: `test:${assistantId}`,
  } as unknown as Connection);
  return received;
}

/** What the daemon does with a presence post: record it, refuse it, or hang up. */
type PresencePostOutcome = true | false | "throw";

/**
 * Register a connection that records every presence post it is handed, whether
 * or not the daemon takes it. `outcome` is read on each post, so a test can
 * flip a daemon between recording and refusing mid-run: `"throw"` stands in for
 * a timeout, `false` for the `recorded: false` reply postPresence folds every
 * accepted-but-unrecorded outcome into.
 *
 * The returned list is the attempt log, so silence in it is the router
 * deciding a report was not worth a request.
 */
function addAttemptingPresenceConnection(
  assistantId: string,
  outcome: { value: PresencePostOutcome },
): PresenceState[] {
  const attempts: PresenceState[] = [];
  const poster = {
    postPresence: async ({ state }: { state: PresenceState }) => {
      attempts.push(state);
      if (outcome.value === "throw") {
        throw new Error("daemon unreachable");
      }
      return outcome.value;
    },
  };
  __testing.connections.set(assistantId, {
    sse: fakeSse(),
    poster,
    fingerprint: `test:${assistantId}`,
  } as unknown as Connection);
  return attempts;
}

/**
 * Register a connection whose presence posts park until released, so a test
 * can inspect what the router does while one is in flight. `started` records a
 * state the moment its request is issued, so its length is the number of
 * requests actually made. `fingerprint` lets a test hand the router a
 * connection the next lockfile change will decide is stale.
 */
function addParkedPresenceConnection(
  assistantId: string,
  fingerprint = `test:${assistantId}`,
): {
  started: PresenceState[];
  release: () => Promise<void>;
} {
  const started: PresenceState[] = [];
  const parked: (() => void)[] = [];
  const poster = {
    postPresence: async ({ state }: { state: PresenceState }) => {
      started.push(state);
      await new Promise<void>((resolve) => {
        parked.push(resolve);
      });
      return true;
    },
  };
  __testing.connections.set(assistantId, {
    sse: fakeSse(),
    poster,
    fingerprint,
  } as unknown as Connection);
  return {
    started,
    release: async () => {
      for (const resolve of parked.splice(0)) {
        resolve();
      }
      await flush();
    },
  };
}

/**
 * Route presence POSTs into a captured list, leaving every other request
 * (the gateway token exchange, the event streams) on its normal mock.
 */
function capturePresencePosts(): { url: string; body: string }[] {
  const posts: { url: string; body: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/clients/presence")) {
      posts.push({ url, body: String(init?.body) });
      return new Response(JSON.stringify({ recorded: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
    // After reset nothing wants to reconnect, so the streams can be dropped
    // without the clients redialing into the next test.
    releaseEventStreams();
    closeEventStreams();
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

    test("retiring an assistant during token acquisition aborts the stale connect", async () => {
      const requests: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        requests.push(String(input));
        return mockGatewayTokenFetch(input);
      }) as typeof globalThis.fetch;
      let resolveToken: ((result: { ok: true; accessToken: string }) => void) | null = null;
      mockGetGuardianAccessToken.mockImplementation(
        () => new Promise((resolve) => { resolveToken = resolve; }),
      );
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "a1", cloud: "local", resources: { gatewayPort: 9001, daemonPort: 9002 } },
        ],
        activeAssistant: "a1",
      });
      await flush();
      expect(__testing.pendingConnects.has("a1")).toBe(true);

      // Retired before the token resolves, so the pending connect is cancelled.
      lockfileListener?.({ assistants: [], activeAssistant: null });
      expect(__testing.pendingConnects.has("a1")).toBe(false);

      resolveToken!({ ok: true, accessToken: "test-token" });
      await flush();

      expect(requests.some((url) => url.includes("/v1/events"))).toBe(false);
      expect(__testing.connections.has("a1")).toBe(false);
      expect(__testing.pendingConnects.size).toBe(0);
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

    test("cloud entry with a stale gatewayPort is classified as cloud, not loopback", async () => {
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
            resources: { gatewayPort: 9001, daemonPort: 9002 },
          },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();

      expect(__testing.connections.get("cloud-1")!.fingerprint).toBe(
        "cloud:https://platform.vellum.ai:",
      );
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

  // -- Paired isolation ----------------------------------------------------

  test("does not open host-proxy connections for paired assistants", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response("ok");
    }) as typeof globalThis.fetch;
    installHostProxyBridge(fakeCliResolver);

    lockfileListener?.({
      assistants: [
        {
          assistantId: "paired-https",
          cloud: "paired",
          runtimeUrl: "https://tunnel.example.com",
          resources: { gatewayPort: 9001, daemonPort: 9002 },
        },
        {
          assistantId: "paired-http",
          cloud: "paired",
          runtimeUrl: "http://192.0.2.10:7831",
        },
      ],
      activeAssistant: "paired-https",
    });
    await flush();

    expect(__testing.connections.size).toBe(0);
    expect(__testing.pendingConnects.size).toBe(0);
    expect(mockGetGuardianAccessToken).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
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

    test("holds the seed until the SSE stream is live", async () => {
      const presencePosts = capturePresencePosts();
      const releaseStreams = holdEventStreams();

      installHostProxyBridge(fakeCliResolver);
      presenceReporter?.("idle");
      await flush();

      lockfileListener?.(MIXED_LOCKFILE);
      await flush();

      // Both connections exist and have called connect(), but no stream is up
      // yet, so the daemon has no subscriber to attribute a report to.
      expect(__testing.connections.size).toBe(2);
      expect(presencePosts).toEqual([]);

      releaseStreams();
      await flush();

      expect(presencePosts.map((post) => post.url).sort()).toEqual([
        "http://127.0.0.1:9001/v1/clients/presence",
        "https://platform.vellum.ai/v1/assistants/cloud-1/clients/presence",
      ]);
      expect(JSON.parse(presencePosts[0]!.body)).toEqual({ state: "idle" });
    });

    test("re-seeds when a dropped SSE stream reconnects", async () => {
      const presencePosts = capturePresencePosts();

      installHostProxyBridge(fakeCliResolver);
      presenceReporter?.("idle");
      lockfileListener?.({
        assistants: [
          { assistantId: "cloud-1", cloud: "vellum", runtimeUrl: "https://platform.vellum.ai" },
        ],
        activeAssistant: "cloud-1",
      });
      await flush();
      expect(presencePosts).toHaveLength(1);

      // A dropped stream takes the daemon's subscriber and its presence record
      // with it, so the reconnect has to say it again.
      closeEventStreams();
      await flush(1_500);

      expect(presencePosts.length).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(presencePosts[1]!.body)).toEqual({ state: "idle" });
    });

    test("skips posts while the SSE stream is down", async () => {
      installHostProxyBridge(fakeCliResolver);
      const sse = fakeSse();
      const received = addPresenceConnection("a1", { sse });

      presenceReporter?.("active");
      await flush();
      expect(received).toEqual(["active"]);

      mockLogWarn.mockClear();
      sse.isConnected = false;
      presenceReporter?.("idle");
      await flush();

      // Nothing sent, and nothing logged: an unattributable report is not a
      // presence failure, and no record on file lets the push through.
      expect(received).toEqual(["active"]);
      expect(mockLogWarn).not.toHaveBeenCalled();
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

    test("keeps the bridge alive when the monitor fails to install", async () => {
      mockInstallPresenceMonitor.mockImplementationOnce(() => {
        throw new Error("powerMonitor unavailable");
      });

      // The bridge installs inside app.whenReady() ahead of the tray, native
      // auth, and the main window, so a throw escaping here would cost the
      // user the app for the sake of a notification optimization.
      let teardown: (() => void) | undefined;
      expect(() => {
        teardown = installHostProxyBridge(fakeCliResolver);
      }).not.toThrow();

      expect(__testing.executors.has("host_bash")).toBe(true);
      expect(__testing.executors.has("host_browser")).toBe(true);

      lockfileListener?.(MIXED_LOCKFILE);
      await flush();
      expect(__testing.connections.has("local-1")).toBe(true);
      expect(__testing.connections.has("cloud-1")).toBe(true);

      expect(() => teardown?.()).not.toThrow();
      expect(mockPresenceTeardown).not.toHaveBeenCalled();
      expect(__testing.connections.size).toBe(0);
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

    test("posts active on every report, even once the daemon recorded it", async () => {
      installHostProxyBridge(fakeCliResolver);
      const received = addPresenceConnection("a1");

      // The daemon expires presence after a staleness bound and `active` is
      // the only state that suppresses anything, so a recorded `active` still
      // has to be said again on every tick.
      presenceReporter?.("active");
      await flush();
      presenceReporter?.("active");
      await flush();
      presenceReporter?.("active");
      await flush();

      expect(received).toEqual(["active", "active", "active"]);
    });

    test("posts a repeated non-active state once, then stays silent", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon: { value: PresencePostOutcome } = { value: true };
      const attempts = addAttemptingPresenceConnection("a1", daemon);

      // An expired record and a repeated `idle` read the same downstream, so
      // once the daemon has confirmed it the repeats buy nothing.
      presenceReporter?.("idle");
      await flush();
      presenceReporter?.("idle");
      await flush();
      presenceReporter?.("idle");
      await flush();

      expect(attempts).toEqual(["idle"]);
    });

    test("retries a non-active post that failed on the next report", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon: { value: PresencePostOutcome } = { value: "throw" };
      const attempts = addAttemptingPresenceConnection("a1", daemon);

      presenceReporter?.("away");
      await flush();
      presenceReporter?.("away");
      await flush();
      presenceReporter?.("away");
      await flush();

      // Nothing landed, so the daemon may still be holding the `active` this
      // `away` is meant to displace. Going quiet would leave it there for the
      // length of the staleness window.
      expect(attempts).toEqual(["away", "away", "away"]);

      daemon.value = true;
      presenceReporter?.("away");
      await flush();
      presenceReporter?.("away");
      await flush();

      // The one that lands is the one that earns the silence.
      expect(attempts).toEqual(["away", "away", "away", "away"]);
    });

    test("retries a non-active post the daemon answered unrecorded", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon: { value: PresencePostOutcome } = { value: false };
      const attempts = addAttemptingPresenceConnection("a1", daemon);

      // A 200 saying the report was not recorded (unknown client, ownership
      // mismatch, subscriber not back yet) leaves the daemon exactly as it was.
      presenceReporter?.("idle");
      await flush();
      presenceReporter?.("idle");
      await flush();

      expect(attempts).toEqual(["idle", "idle"]);
    });

    test("one assistant recording a state does not silence another", async () => {
      installHostProxyBridge(fakeCliResolver);
      const recording: { value: PresencePostOutcome } = { value: true };
      const refusing: { value: PresencePostOutcome } = { value: false };
      const first = addAttemptingPresenceConnection("a1", recording);
      const second = addAttemptingPresenceConnection("a2", refusing);

      presenceReporter?.("away");
      await flush();
      presenceReporter?.("away");
      await flush();

      // "Does this daemon already know" is a question per daemon, so the one
      // that never took the report keeps hearing it.
      expect(first).toEqual(["away"]);
      expect(second).toEqual(["away", "away"]);
    });

    test("posts a transition even to a state recorded earlier", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon: { value: PresencePostOutcome } = { value: true };
      const attempts = addAttemptingPresenceConnection("a1", daemon);

      presenceReporter?.("idle");
      await flush();
      presenceReporter?.("active");
      await flush();
      presenceReporter?.("idle");
      await flush();

      // The `active` in between is what the daemon holds now, so the return to
      // `idle` is news whatever was recorded before it.
      expect(attempts).toEqual(["idle", "active", "idle"]);
    });

    test("seeds an assistant with a state it has already recorded", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon: { value: PresencePostOutcome } = { value: true };
      const attempts = addAttemptingPresenceConnection("a1", daemon);

      presenceReporter?.("idle");
      await flush();
      expect(attempts).toEqual(["idle"]);

      // The stream a seed rides went down and took the daemon's record with
      // it, so what that daemon last confirmed cannot gate the seed.
      __testing.seedPresence("a1");
      await flush();

      expect(attempts).toEqual(["idle", "idle"]);
    });

    test("seeds a joining assistant with a state a sibling already recorded", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon: { value: PresencePostOutcome } = { value: true };
      const first = addAttemptingPresenceConnection("a1", daemon);

      presenceReporter?.("away");
      await flush();
      expect(first).toEqual(["away"]);

      const joining = addAttemptingPresenceConnection("a2", daemon);
      __testing.seedPresence("a2");
      await flush();

      // A newly connected daemon knows nothing, whatever its siblings hold.
      expect(joining).toEqual(["away"]);
    });

    test("keeps the recorded state across a reconnect", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon: { value: PresencePostOutcome } = { value: true };
      addAttemptingPresenceConnection("a1", daemon);

      presenceReporter?.("idle");
      await flush();

      // A reconnect runs through disconnectAssistant, and a recorded entry can
      // only name a non-active state, which suppresses nothing. The seed on
      // the fresh stream covers the record the drop took with it.
      __testing.disconnectAssistant("a1");
      const fresh = addAttemptingPresenceConnection("a1", daemon);
      presenceReporter?.("idle");
      await flush();

      expect(fresh).toEqual([]);
    });

    test("forgets a recorded state once the assistant leaves the lockfile", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon: { value: PresencePostOutcome } = { value: true };
      const first = addAttemptingPresenceConnection("a1", daemon);

      presenceReporter?.("idle");
      await flush();
      expect(first).toEqual(["idle"]);

      lockfileListener?.({ assistants: [], activeAssistant: null });
      await flush();
      expect(__testing.lastRecordedState.has("a1")).toBe(false);

      // An assistant that comes back is a daemon that started over.
      const second = addAttemptingPresenceConnection("a1", daemon);
      presenceReporter?.("idle");
      await flush();

      expect(second).toEqual(["idle"]);
    });

    test("forgets recorded states on bridge teardown", async () => {
      const teardown = installHostProxyBridge(fakeCliResolver);
      const daemon: { value: PresencePostOutcome } = { value: true };
      const first = addAttemptingPresenceConnection("a1", daemon);

      presenceReporter?.("idle");
      await flush();
      expect(first).toEqual(["idle"]);

      teardown();
      expect(__testing.lastRecordedState.size).toBe(0);

      installHostProxyBridge(fakeCliResolver);
      const second = addAttemptingPresenceConnection("a1", daemon);
      presenceReporter?.("idle");
      await flush();

      expect(second).toEqual(["idle"]);
    });

    test("does not skip a repeat while a post is in flight", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon: { value: PresencePostOutcome } = { value: true };
      const recorded = addAttemptingPresenceConnection("a1", daemon);

      presenceReporter?.("away");
      await flush();
      expect(recorded).toEqual(["away"]);

      const parked = addParkedPresenceConnection("a1");
      presenceReporter?.("active");
      await flush();
      expect(parked.started).toEqual(["active"]);

      presenceReporter?.("away");
      await flush();
      expect(parked.started).toEqual(["active"]);

      // The in-flight `active` is about to become the record, so the `away`
      // behind it cannot be judged against what was confirmed before it.
      // Dropping it would leave the daemon holding `active` for a locked Mac.
      await parked.release();
      expect(parked.started).toEqual(["active", "away"]);

      await parked.release();
    });

    test("holds a report that arrives while a post is in flight", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon = addParkedPresenceConnection("a1");

      presenceReporter?.("active");
      await flush();
      expect(daemon.started).toEqual(["active"]);

      presenceReporter?.("away");
      await flush();

      // Still one request: a second would have no ordering guarantee against
      // the first, so the newer state waits its turn instead.
      expect(daemon.started).toEqual(["active"]);

      await daemon.release();
      expect(daemon.started).toEqual(["active", "away"]);
    });

    test("collapses reports queued behind one post down to the newest", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon = addParkedPresenceConnection("a1");

      presenceReporter?.("active");
      await flush();

      presenceReporter?.("idle");
      presenceReporter?.("active");
      presenceReporter?.("away");
      await flush();
      expect(daemon.started).toEqual(["active"]);

      // One follow-up carrying the last state. The two the user has already
      // left are worth no request of their own.
      await daemon.release();
      expect(daemon.started).toEqual(["active", "away"]);

      await daemon.release();
      expect(daemon.started).toEqual(["active", "away"]);
    });

    test("stops when the queued state matches the post that just settled", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon = addParkedPresenceConnection("a1");

      presenceReporter?.("active");
      await flush();
      presenceReporter?.("active");
      await flush();

      await daemon.release();
      expect(daemon.started).toEqual(["active"]);
    });

    test("never leaves a stale active as the daemon's last write", async () => {
      installHostProxyBridge(fakeCliResolver);

      // The daemon stamps a report when it lands, so landing order is what
      // decides the record. A slow `active` overtaken by a fast `away` is
      // just locking the screen right after a poll tick, and leaving the
      // daemon holding a freshly stamped `active` for a machine the user has
      // walked away from is the one outcome presence must never produce.
      const landed: PresenceState[] = [];
      const poster = {
        postPresence: async ({ state }: { state: PresenceState }) => {
          await flush(state === "active" ? 60 : 5);
          landed.push(state);
          return true;
        },
      };
      __testing.connections.set("a1", {
        sse: fakeSse(),
        poster,
        fingerprint: "test:a1",
      } as unknown as Connection);

      presenceReporter?.("active");
      presenceReporter?.("away");
      await flush(300);

      expect(landed).toEqual(["active", "away"]);
    });

    test("a parked post on one assistant does not delay another", async () => {
      installHostProxyBridge(fakeCliResolver);
      const parked = addParkedPresenceConnection("a1");
      const responsive = addPresenceConnection("a2");

      presenceReporter?.("active");
      await flush();
      presenceReporter?.("away");
      await flush();

      expect(parked.started).toEqual(["active"]);
      expect(responsive).toEqual(["active", "away"]);

      await parked.release();
      expect(parked.started).toEqual(["active", "away"]);
    });

    test("a seed queued behind an in-flight post cannot overtake it", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon = addParkedPresenceConnection("a1");

      presenceReporter?.("active");
      await flush();
      presenceReporter?.("away");
      await flush();
      expect(daemon.started).toEqual(["active"]);

      // A stream coming back up seeds the cached state through the same
      // queue, so it joins the wait rather than racing the parked post.
      __testing.seedPresence("a1");
      await flush();
      expect(daemon.started).toEqual(["active"]);

      await daemon.release();
      expect(daemon.started).toEqual(["active", "away"]);
    });

    test("a reconnect while a post is in flight starts no second post", async () => {
      installHostProxyBridge(fakeCliResolver);
      const stale = addParkedPresenceConnection("a1");

      presenceReporter?.("active");
      await flush();
      expect(stale.started).toEqual(["active"]);

      // What a reconnect does: drop the connection, build a fresh one. The
      // post the old connection has out is not aborted by either step.
      __testing.disconnectAssistant("a1");
      const fresh = addPresenceConnection("a1");

      presenceReporter?.("away");
      await flush();

      // The queue is keyed by assistant, so the fresh connection inherits the
      // latch instead of racing a post that is still out under the same
      // client id.
      expect(fresh).toEqual([]);
      expect(stale.started).toEqual(["active"]);
    });

    test("sends a queued state through the connection that replaced the old one", async () => {
      installHostProxyBridge(fakeCliResolver);
      const stale = addParkedPresenceConnection("a1");

      presenceReporter?.("active");
      await flush();

      __testing.disconnectAssistant("a1");
      const fresh = addPresenceConnection("a1");
      presenceReporter?.("away");
      await flush();
      expect(fresh).toEqual([]);

      await stale.release();

      // The drain re-reads the connection each pass, so once the stale post
      // settles the waiting state goes out over the live connection rather
      // than a poster nothing is listening to.
      expect(fresh).toEqual(["away"]);
      expect(stale.started).toEqual(["active"]);
    });

    test("a stale post cannot outlast the away reported after a reconnect", async () => {
      installHostProxyBridge(fakeCliResolver);

      // Both generations post under the same client id, so the daemon files
      // them under one record and stamps it on receipt: landing order is what
      // decides the record.
      const landed: PresenceState[] = [];
      const setConnection = (latencyMs: number) => {
        __testing.connections.set("a1", {
          sse: fakeSse(),
          poster: {
            postPresence: async ({ state }: { state: PresenceState }) => {
              await flush(latencyMs);
              landed.push(state);
              return true;
            },
          },
          fingerprint: "test:a1",
        } as unknown as Connection);
      };

      setConnection(80);
      presenceReporter?.("active");
      await flush();

      setConnection(5);
      presenceReporter?.("away");
      await flush(400);

      // A fresh latch per connection would let the quick away land first and
      // the slow active overwrite it, leaving the daemon holding "attended"
      // for a locked Mac and swallowing the push.
      expect(landed).toEqual(["active", "away"]);
    });

    test("clears the presence queue when the assistant leaves the lockfile", async () => {
      installHostProxyBridge(fakeCliResolver);
      const daemon = addParkedPresenceConnection("a1");

      presenceReporter?.("active");
      await flush();
      presenceReporter?.("away");
      await flush();
      expect(__testing.presencePostQueues.has("a1")).toBe(true);

      lockfileListener?.({ assistants: [], activeAssistant: null });
      await flush();

      expect(__testing.connections.has("a1")).toBe(false);
      expect(__testing.presencePostQueues.has("a1")).toBe(false);

      // Nothing is left to report to, and reporting nothing lets the push
      // through, so the waiting state is dropped rather than posted.
      await daemon.release();
      expect(daemon.started).toEqual(["active"]);
    });

    test("keeps the presence queue across a fingerprint-change reconnect", async () => {
      const presencePosts = capturePresencePosts();

      installHostProxyBridge(fakeCliResolver);
      const stale = addParkedPresenceConnection(
        "cloud-1",
        "cloud:https://platform.vellum.ai:org-a",
      );

      presenceReporter?.("active");
      await flush();
      expect(stale.started).toEqual(["active"]);
      const queued = __testing.presencePostQueues.get("cloud-1");
      expect(queued).toBeDefined();

      // Same endpoint, new organizationId: the router rebuilds the connection
      // while the old post is still out against that very daemon.
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
      presenceReporter?.("away");
      await flush();

      expect(__testing.connections.get("cloud-1")!.fingerprint).toBe(
        "cloud:https://platform.vellum.ai:org-b",
      );
      // Same queue object, so the fresh connection's seed waited its turn
      // instead of opening a second post.
      expect(__testing.presencePostQueues.get("cloud-1")).toBe(queued);
      expect(presencePosts).toEqual([]);

      await stale.release();
      await flush();

      expect(presencePosts).toHaveLength(1);
      expect(JSON.parse(presencePosts[0]!.body)).toEqual({ state: "away" });
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
