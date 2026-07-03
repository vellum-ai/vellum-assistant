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

// Track net.fetch calls so tests can assert on the probe target.
let fetchCalls: string[] = [];
let fetchResponseOk = true;
mock.module("electron", () => ({
  app: {
    on: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  net: {
    fetch: (url: string) => {
      fetchCalls.push(url);
      if (fetchResponseOk) {
        return Promise.resolve({ ok: true } as Response);
      }
      return Promise.reject(new Error("connection refused"));
    },
  },
  powerMonitor: {
    on: () => {},
  },
}));

// Control the lockfile data returned by getLockfileData.
type LockfileEntry = {
  assistantId: string;
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
  fetchResponseOk = true;
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
            resources: { gatewayPort: 7830 },
          },
        ],
        activeAssistant: "local-1",
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual(["http://127.0.0.1:7830/healthz"]);
    expect(backendReachableCalls).toEqual([true]);
  });

  test("sets backend reachable=true when active assistant is cloud (no gatewayPort)", async () => {
    // Simulate a prior local-assistant probe having set backendReachable=false.
    // The probe should clear that stale state when the active assistant is cloud.
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "cloud-1",
            // No resources.gatewayPort: cloud assistant
          },
        ],
        activeAssistant: "cloud-1",
      },
    };

    await runProbe();

    // No fetch should have been made (no local gateway to probe).
    expect(fetchCalls).toEqual([]);
    // The stale unreachable state should be cleared.
    expect(backendReachableCalls).toEqual([true]);
  });

  test("sets backend reachable=true when there is no active assistant", async () => {
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [],
        activeAssistant: null,
      },
    };

    await runProbe();

    expect(fetchCalls).toEqual([]);
    expect(backendReachableCalls).toEqual([true]);
  });

  test("sets backend reachable=false when local gateway is unreachable", async () => {
    fetchResponseOk = false;
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "local-1",
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
    fetchResponseOk = false;
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "local-1",
            resources: { gatewayPort: 7830 },
          },
          {
            assistantId: "cloud-1",
          },
        ],
        activeAssistant: "local-1",
      },
    };

    await runProbe();
    expect(backendReachableCalls).toEqual([false]);

    // Simulate lockfile change: active assistant is now the cloud one.
    fetchResponseOk = true;
    mockLockfileData = {
      ok: true,
      data: {
        assistants: [
          {
            assistantId: "local-1",
            resources: { gatewayPort: 7830 },
          },
          {
            assistantId: "cloud-1",
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
});
