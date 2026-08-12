import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track setBackendReachable calls so tests can assert on them.
let backendReachableCalls: boolean[] = [];
mock.module("./status", () => ({
  setBackendReachable: (reachable: boolean) => {
    backendReachableCalls.push(reachable);
  },
}));

// Track net.fetch calls so tests can assert on the probe target and headers.
let fetchCalls: string[] = [];
let fetchHeaders: (Record<string, string> | undefined)[] = [];
let fetchBehavior: "ok" | "http-error" | "reject" = "ok";
mock.module("electron", () => ({
  app: {
    on: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  net: {
    fetch: (url: string, init?: { headers?: Record<string, string> }) => {
      fetchCalls.push(url);
      fetchHeaders.push(init?.headers);
      if (fetchBehavior === "reject") {
        return Promise.reject(new Error("connection refused"));
      }
      return Promise.resolve({ ok: fetchBehavior === "ok" } as Response);
    },
  },
  powerMonitor: {
    on: () => {},
  },
}));

// Control the lockfile data returned by getLockfileData.
type LockfileEntry = {
  assistantId: string;
  cloud?: string;
  runtimeUrl?: string;
  resources?: { gatewayPort?: number };
};
type LockfileData = {
  assistants: LockfileEntry[];
  activeAssistant: string | null;
};
let mockLockfileData: { ok: boolean; data?: LockfileData } = {
  ok: true,
  data: { assistants: [], activeAssistant: null },
};
mock.module("@vellumai/local-mode", () => ({
  getLockfileData: () => mockLockfileData,
}));

const { installConnectivityProbe } = await import("./connectivity-probe");

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

// installConnectivityProbe has a module-level guard (probeTimer) that prevents
// double-starting. Call it once and use the returned runProbe to trigger
// individual probe cycles with different lockfile states.
const runProbe = installConnectivityProbe(["/mock/lockfile.json"]);

beforeEach(() => {
  backendReachableCalls = [];
  fetchCalls = [];
  fetchHeaders = [];
  fetchBehavior = "ok";
  mockLockfileData = { ok: true, data: { assistants: [], activeAssistant: null } };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("connectivity-probe", () => {
  test("probes local gateway /healthz when active assistant has a gatewayPort", async () => {
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "local-1",
            cloud: "local",
            resources: { gatewayPort: 7830 },
          },
        ],
        activeAssistant: "local-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual(["http://127.0.0.1:7830/healthz"]);
    // Local probes carry no extra headers.
    expect(fetchHeaders).toEqual([undefined]);
    expect(backendReachableCalls).toEqual([true]);
  });

  test("sets backend reachable=true when active assistant is cloud-hosted", async () => {
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
            // No resources.gatewayPort: cloud assistant
          },
        ],
        activeAssistant: "cloud-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual([]);
    expect(backendReachableCalls).toEqual([true]);
  });

  test("sets backend reachable=true when a cloud assistant carries leftover local resources", async () => {
    // A stale gatewayPort merged onto a platform entry must not be probed.
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
            resources: { gatewayPort: 7830 },
          },
        ],
        activeAssistant: "cloud-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual([]);
    expect(backendReachableCalls).toEqual([true]);
  });

  test("probes docker assistants over their loopback gateway", async () => {
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "docker-1",
            cloud: "docker",
            resources: { gatewayPort: 7840 },
          },
        ],
        activeAssistant: "docker-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual(["http://127.0.0.1:7840/healthz"]);
    expect(backendReachableCalls).toEqual([true]);
  });

  test("recovers the docker probe port from a loopback runtimeUrl", async () => {
    // Docker hatch records the published gateway as a loopback runtimeUrl
    // with no `resources` block.
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "docker-1",
            cloud: "docker",
            runtimeUrl: "http://localhost:7841",
          },
        ],
        activeAssistant: "docker-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual(["http://127.0.0.1:7841/healthz"]);
    expect(backendReachableCalls).toEqual([true]);
  });

  test("does not probe a non-loopback runtimeUrl", async () => {
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "docker-1",
            cloud: "docker",
            runtimeUrl: "http://192.0.2.10:7841",
          },
        ],
        activeAssistant: "docker-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual([]);
    expect(backendReachableCalls).toEqual([]);
  });

  test("does not change reachability when lockfile cannot be read", async () => {
    mockLockfileData = { ok: false };

    await runProbe();

    expect(fetchCalls).toEqual([]);
    expect(backendReachableCalls).toEqual([]);
  });

  test("does not change reachability when there is no active assistant", async () => {
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [],
        activeAssistant: null,
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual([]);
    expect(backendReachableCalls).toEqual([]);
  });

  test("does not change reachability when local entry is missing gatewayPort", async () => {
    // A local entry without a gatewayPort is a degenerate state — we can't
    // probe and we can't prove reachability, so we leave the state unchanged
    // rather than falsely clearing or setting unreachable.
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "local-1",
            cloud: "local",
            // No resources at all
          },
        ],
        activeAssistant: "local-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual([]);
    expect(backendReachableCalls).toEqual([]);
  });

  test("sets backend reachable=false when local gateway is unreachable", async () => {
    fetchBehavior = "reject";
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "local-1",
            cloud: "local",
            resources: { gatewayPort: 7830 },
          },
        ],
        activeAssistant: "local-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual(["http://127.0.0.1:7830/healthz"]);
    expect(backendReachableCalls).toEqual([false]);
  });

  test("clears stale unreachable when switching from local to cloud assistant", async () => {
    // First probe: local assistant with a dead gateway.
    fetchBehavior = "reject";
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "local-1",
            cloud: "local",
            resources: { gatewayPort: 7830 },
          },
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
          },
        ],
        activeAssistant: "local-1",
      },
    };

    await runProbe();
    expect(backendReachableCalls).toEqual([false]);

    // Simulate lockfile change: active assistant is now the cloud one.
    fetchBehavior = "ok";
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "local-1",
            cloud: "local",
            resources: { gatewayPort: 7830 },
          },
          {
            assistantId: "cloud-1",
            cloud: "vellum",
            runtimeUrl: "https://platform.vellum.ai",
          },
        ],
        activeAssistant: "cloud-1",
      },
    };

    await runProbe();
    // The stale false should be cleared to true.
    expect(backendReachableCalls).toEqual([false, true]);
    // No fetch was made for the cloud probe.
    expect(fetchCalls).toEqual(["http://127.0.0.1:7830/healthz"]);
  });

  test("probes a paired assistant's tunnel /healthz with the ngrok skip header", async () => {
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "paired-1",
            cloud: "paired",
            runtimeUrl: "https://abc123.ngrok.app",
          },
        ],
        activeAssistant: "paired-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual(["https://abc123.ngrok.app/healthz"]);
    expect(fetchHeaders).toEqual([{ "ngrok-skip-browser-warning": "true" }]);
    expect(backendReachableCalls).toEqual([true]);
  });

  test("strips trailing slashes from the paired runtimeUrl before appending /healthz", async () => {
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "paired-1",
            cloud: "paired",
            runtimeUrl: "https://abc123.ngrok.app/",
          },
        ],
        activeAssistant: "paired-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual(["https://abc123.ngrok.app/healthz"]);
    expect(backendReachableCalls).toEqual([true]);
  });

  test("sets backend reachable=false when the paired tunnel is dead", async () => {
    fetchBehavior = "reject";
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "paired-1",
            cloud: "paired",
            runtimeUrl: "https://abc123.ngrok.app",
          },
        ],
        activeAssistant: "paired-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual(["https://abc123.ngrok.app/healthz"]);
    expect(backendReachableCalls).toEqual([false]);
  });

  test("sets backend reachable=false when the paired tunnel answers non-2xx", async () => {
    fetchBehavior = "http-error";
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "paired-1",
            cloud: "paired",
            runtimeUrl: "https://abc123.ngrok.app",
          },
        ],
        activeAssistant: "paired-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual(["https://abc123.ngrok.app/healthz"]);
    expect(backendReachableCalls).toEqual([false]);
  });

  test("sets backend reachable=false when a paired entry has an unusable runtimeUrl", async () => {
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "paired-1",
            cloud: "paired",
            runtimeUrl: "not-a-url",
          },
        ],
        activeAssistant: "paired-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual([]);
    expect(backendReachableCalls).toEqual([false]);
  });

  test("sets backend reachable=false when a paired entry has no runtimeUrl", async () => {
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "paired-1",
            cloud: "paired",
          },
        ],
        activeAssistant: "paired-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual([]);
    expect(backendReachableCalls).toEqual([false]);
  });
});
