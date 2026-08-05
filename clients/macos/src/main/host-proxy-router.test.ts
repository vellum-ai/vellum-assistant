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

  // -- Paired lifecycle ----------------------------------------------------

  describe("paired lifecycle", () => {
    /** Swap globalThis.fetch for one that records every request it serves. */
    function recordingFetch(): { url: string; headers: Record<string, string> }[] {
      const requests: { url: string; headers: Record<string, string> }[] = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        });
        return new Response("ok");
      }) as typeof globalThis.fetch;
      return requests;
    }

    test("connects with the guardian bearer against the remote events URL", async () => {
      const requests = recordingFetch();
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "paired-1", cloud: "paired", runtimeUrl: "https://tunnel.example.com" },
        ],
        activeAssistant: "paired-1",
      });
      await flush();

      expect(__testing.connections.has("paired-1")).toBe(true);
      expect(__testing.connections.get("paired-1")!.fingerprint).toBe(
        "paired:https://tunnel.example.com:paired-1",
      );

      const sseRequest = requests.find((r) => r.url === "https://tunnel.example.com/v1/events");
      expect(sseRequest).toBeDefined();
      expect(sseRequest!.headers.Authorization).toBe("Bearer test-token");
      expect(sseRequest!.headers["ngrok-skip-browser-warning"]).toBe("true");

      // The paired flag rides along so an expired-refresh failure surfaces
      // re-pair guidance instead of hatch/wake.
      expect(mockGetGuardianAccessToken.mock.calls[0]?.[5]).toEqual({ paired: true });
    });

    test("never issues a token-exchange request for a paired entry", async () => {
      const requests = recordingFetch();
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "paired-1", cloud: "paired", runtimeUrl: "https://tunnel.example.com" },
        ],
        activeAssistant: "paired-1",
      });
      await flush();

      expect(__testing.connections.has("paired-1")).toBe(true);
      expect(requests.some((r) => r.url.includes("/auth/token"))).toBe(false);
    });

    test("trailing slashes on runtimeUrl are stripped from the events URL", async () => {
      const requests = recordingFetch();
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "paired-1", cloud: "paired", runtimeUrl: "https://tunnel.example.com//" },
        ],
        activeAssistant: "paired-1",
      });
      await flush();

      expect(requests.some((r) => r.url === "https://tunnel.example.com/v1/events")).toBe(true);
    });

    test("reconnects when the runtimeUrl changes", async () => {
      recordingFetch();
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "paired-1", cloud: "paired", runtimeUrl: "https://old-tunnel.example.com" },
        ],
        activeAssistant: "paired-1",
      });
      await flush();
      const firstSse = __testing.connections.get("paired-1")!.sse;

      lockfileListener?.({
        assistants: [
          { assistantId: "paired-1", cloud: "paired", runtimeUrl: "https://new-tunnel.example.com" },
        ],
        activeAssistant: "paired-1",
      });
      await flush();

      expect(__testing.connections.get("paired-1")!.sse).not.toBe(firstSse);
      expect(__testing.connections.get("paired-1")!.fingerprint).toBe(
        "paired:https://new-tunnel.example.com:paired-1",
      );
    });

    test("skips paired entries without a usable runtimeUrl", async () => {
      recordingFetch();
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "paired-no-url", cloud: "paired" },
          { assistantId: "paired-bad-url", cloud: "paired", runtimeUrl: "not-a-url" },
        ],
        activeAssistant: null,
      });
      await flush();

      expect(__testing.connections.size).toBe(0);
    });

    test("paired entry with a stale gatewayPort still connects via the runtimeUrl", async () => {
      const requests = recordingFetch();
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          {
            assistantId: "paired-1",
            cloud: "paired",
            runtimeUrl: "https://tunnel.example.com",
            resources: { gatewayPort: 9001, daemonPort: 9002 },
          },
        ],
        activeAssistant: "paired-1",
      });
      await flush();

      expect(__testing.connections.get("paired-1")!.fingerprint).toBe(
        "paired:https://tunnel.example.com:paired-1",
      );
      // No loopback token exchange or loopback SSE against the stale port.
      expect(requests.some((r) => r.url.includes("/auth/token"))).toBe(false);
      expect(requests.some((r) => r.url.startsWith("http://127.0.0.1:9001"))).toBe(false);
      expect(requests.some((r) => r.url === "https://tunnel.example.com/v1/events")).toBe(true);
    });

    test("paired poster refreshes the guardian bearer and retries once on 401", async () => {
      const posts: { headers: Record<string, string> }[] = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/host-bash-result")) {
          posts.push({ headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
          return new Response("{}", { status: posts.length === 1 ? 401 : 200 });
        }
        return new Response("ok");
      }) as typeof globalThis.fetch;
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "paired-1", cloud: "paired", runtimeUrl: "https://tunnel.example.com" },
        ],
        activeAssistant: "paired-1",
      });
      await flush();

      // The expired-bearer refresh path re-acquires the guardian token.
      mockGetGuardianAccessToken.mockImplementation(
        async () => ({ ok: true, accessToken: "fresh-token" }),
      );

      const ok = await __testing.connections
        .get("paired-1")!
        .poster.postBashResult({ requestId: "r1", stdout: "" });

      expect(ok).toBe(true);
      expect(posts).toHaveLength(2);
      expect(posts[0].headers.Authorization).toBe("Bearer test-token");
      expect(posts[1].headers.Authorization).toBe("Bearer fresh-token");
      // The refresh keeps the paired flag so failures surface re-pair guidance.
      expect(mockGetGuardianAccessToken.mock.calls.at(-1)?.[5]).toEqual({ paired: true });
    });

    test("unpairing during token acquisition aborts the stale connect", async () => {
      const requests = recordingFetch();
      let resolveToken: ((result: { ok: true; accessToken: string }) => void) | null = null;
      mockGetGuardianAccessToken.mockImplementation(
        () => new Promise((resolve) => { resolveToken = resolve; }),
      );
      installHostProxyBridge(fakeCliResolver);

      // Paired entry appears; connect blocks on the slow token acquisition.
      lockfileListener?.({
        assistants: [
          { assistantId: "paired-1", cloud: "paired", runtimeUrl: "https://stale-tunnel.example.com" },
        ],
        activeAssistant: "paired-1",
      });
      await flush();
      expect(__testing.pendingConnects.has("paired-1")).toBe(true);

      // Unpaired before the token resolves, so the pending connect is cancelled.
      lockfileListener?.({ assistants: [], activeAssistant: null });
      expect(__testing.pendingConnects.has("paired-1")).toBe(false);

      resolveToken!({ ok: true, accessToken: "test-token" });
      await flush();

      // No SSE was opened or recorded against the stale runtimeUrl.
      expect(requests.some((r) => r.url.startsWith("https://stale-tunnel.example.com"))).toBe(false);
      expect(__testing.connections.has("paired-1")).toBe(false);
      expect(__testing.pendingConnects.size).toBe(0);
    });

    test("retargeting during token acquisition connects only to the new runtimeUrl", async () => {
      const requests = recordingFetch();
      let resolveFirstToken: ((result: { ok: true; accessToken: string }) => void) | null = null;
      let tokenCalls = 0;
      mockGetGuardianAccessToken.mockImplementation(() => {
        tokenCalls += 1;
        if (tokenCalls === 1) {
          return new Promise((resolve) => { resolveFirstToken = resolve; });
        }
        return Promise.resolve({ ok: true, accessToken: "fresh-token" });
      });
      installHostProxyBridge(fakeCliResolver);

      lockfileListener?.({
        assistants: [
          { assistantId: "paired-1", cloud: "paired", runtimeUrl: "https://old-tunnel.example.com" },
        ],
        activeAssistant: "paired-1",
      });
      await flush();

      // Retarget while the first token acquisition is still pending.
      lockfileListener?.({
        assistants: [
          { assistantId: "paired-1", cloud: "paired", runtimeUrl: "https://new-tunnel.example.com" },
        ],
        activeAssistant: "paired-1",
      });
      await flush();
      expect(__testing.connections.get("paired-1")!.fingerprint).toBe(
        "paired:https://new-tunnel.example.com:paired-1",
      );

      // The stale connect resolves late and must not open SSE or clobber the entry.
      resolveFirstToken!({ ok: true, accessToken: "stale-token" });
      await flush();

      expect(requests.some((r) => r.url.startsWith("https://old-tunnel.example.com"))).toBe(false);
      expect(__testing.connections.get("paired-1")!.fingerprint).toBe(
        "paired:https://new-tunnel.example.com:paired-1",
      );
      expect(__testing.pendingConnects.size).toBe(0);
    });

    test("repeated lockfile updates during a pending connect do not stack connects", async () => {
      recordingFetch();
      let resolveToken: ((result: { ok: true; accessToken: string }) => void) | null = null;
      const tokenPromises: Promise<{ ok: true; accessToken: string }>[] = [];
      mockGetGuardianAccessToken.mockImplementation(() => {
        const p = new Promise<{ ok: true; accessToken: string }>((resolve) => { resolveToken = resolve; });
        tokenPromises.push(p);
        return p;
      });
      installHostProxyBridge(fakeCliResolver);

      const lockfile: Lockfile = {
        assistants: [
          { assistantId: "paired-1", cloud: "paired", runtimeUrl: "https://tunnel.example.com" },
        ],
        activeAssistant: "paired-1",
      };
      lockfileListener?.(lockfile);
      lockfileListener?.(lockfile);
      lockfileListener?.(lockfile);
      await flush();

      // Only one token acquisition in flight for the unchanged fingerprint.
      expect(tokenPromises.length).toBe(1);

      resolveToken!({ ok: true, accessToken: "test-token" });
      await flush();
      expect(__testing.connections.has("paired-1")).toBe(true);
      expect(__testing.pendingConnects.size).toBe(0);
    });

    test("guardian-token failure skips the paired entry without breaking other connections", async () => {
      recordingFetch();
      mockGetGuardianAccessToken.mockImplementation(
        async () => ({ ok: false, status: 401, error: "expired" }),
      );
      installHostProxyBridge(fakeCliResolver);

      const lockfile: Lockfile = {
        assistants: [
          { assistantId: "paired-1", cloud: "paired", runtimeUrl: "https://tunnel.example.com" },
          { assistantId: "cloud-1", cloud: "vellum", runtimeUrl: "https://platform.vellum.ai" },
        ],
        activeAssistant: "paired-1",
      };
      lockfileListener?.(lockfile);
      await flush();

      // Paired skipped, cloud unaffected
      expect(__testing.connections.has("paired-1")).toBe(false);
      expect(__testing.connections.has("cloud-1")).toBe(true);

      // Token becomes available: retried on the next lockfile cycle
      mockGetGuardianAccessToken.mockImplementation(
        async () => ({ ok: true, accessToken: "fresh-token" }),
      );
      lockfileListener?.(lockfile);
      await flush();

      expect(__testing.connections.has("paired-1")).toBe(true);
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
