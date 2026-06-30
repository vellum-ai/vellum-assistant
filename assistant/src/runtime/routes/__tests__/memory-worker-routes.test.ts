/**
 * Tests for the memory worker control routes (start / stop / status).
 *
 * The route handlers run inside the daemon and own the worker process. We mock
 * worker-control + config so the tests assert the handler behaviour:
 *   - start spawns as a daemon child (detached:false), enables the flag only on
 *     success, and throws on spawn failure (flag untouched).
 *   - stop disables the flag and signals the worker.
 *   - status reports worker + sync-runner + flag.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as actualLoader from "../../../config/loader.js";
import { getMemoryWorkerPidPath } from "../../../util/platform.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

class FakeSpawnError extends Error {}

let spawnImpl: () => Promise<{ pid: number; alreadyRunning: boolean }>;
let spawnArgs: Array<{ detached?: boolean; terminateOnTimeout?: boolean }> = [];
let stopImpl: () => { status: "running" | "not_running"; pid?: number };
/** Records the `memory.worker.enabled` values written via saveRawConfig. */
let enabledCalls: boolean[] = [];
let workerProbe: { status: "running" | "not_running"; pid?: number } = {
  status: "not_running",
};
let configEnabled = false;
let memoryEnabled = true;
let backendStatus: {
  enabled: boolean;
  degraded: boolean;
  provider: string | null;
  model: string | null;
  reason: string | null;
} = {
  enabled: true,
  degraded: false,
  provider: "openai",
  model: "text-embedding-3-small",
  reason: null,
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../persistence/worker-control.js", () => ({
  MemoryWorkerSpawnError: FakeSpawnError,
  spawnMemoryWorkerProcess: async (opts: {
    detached?: boolean;
    terminateOnTimeout?: boolean;
  }) => {
    spawnArgs.push(opts);
    return spawnImpl();
  },
  stopMemoryWorkerProcess: () => stopImpl(),
  probeMemoryWorker: () => workerProbe,
}));

mock.module("../../../persistence/embeddings/embedding-backend.js", () => ({
  getMemoryBackendStatus: async () => backendStatus,
}));

// Spread the real loader so the route-policy import chain keeps every other
// export (getConfig, …). Override the flag read, and capture the flag write
// (the route's setMemoryWorkerEnabled goes through loadRawConfig/saveRawConfig).
mock.module("../../../config/loader.js", () => ({
  ...actualLoader,
  getConfigReadOnly: () => ({
    memory: { enabled: memoryEnabled, worker: { enabled: configEnabled } },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: (cfg: { memory?: { worker?: { enabled?: boolean } } }) => {
    enabledCalls.push(cfg.memory?.worker?.enabled === true);
  },
}));

const { ROUTES, embeddingStatusSchema } = await import(
  "../memory-worker-routes.js"
);

function handler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`route ${operationId} not registered`);
  return route.handler as () => Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  spawnArgs = [];
  enabledCalls = [];
  spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });
  stopImpl = () => ({ status: "not_running" });
  workerProbe = { status: "not_running" };
  configEnabled = false;
  memoryEnabled = true;
  backendStatus = {
    enabled: true,
    degraded: false,
    provider: "openai",
    model: "text-embedding-3-small",
    reason: null,
  };
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe("memory_worker_start", () => {
  test("spawns as a daemon child and enables the flag on success", async () => {
    spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });

    const res = await handler("memory_worker_start")();

    expect(spawnArgs).toEqual([{ detached: false, terminateOnTimeout: true }]);
    expect(enabledCalls).toEqual([true]);
    expect(res).toEqual({
      pid: 4242,
      alreadyRunning: false,
      workerEnabled: true,
      pidPath: getMemoryWorkerPidPath(),
    });
  });

  test("reports an already-running worker without re-spawning", async () => {
    spawnImpl = async () => ({ pid: 99, alreadyRunning: true });

    const res = await handler("memory_worker_start")();

    expect(res).toMatchObject({ pid: 99, alreadyRunning: true });
    expect(enabledCalls).toEqual([true]);
  });

  test("throws and leaves the flag untouched when the spawn fails", async () => {
    spawnImpl = async () => {
      throw new FakeSpawnError("worker exited during startup");
    };

    await expect(handler("memory_worker_start")()).rejects.toThrow(
      "worker exited during startup",
    );
    expect(enabledCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("memory_worker_stop", () => {
  test("disables the flag and reports a signalled running worker", async () => {
    stopImpl = () => ({ status: "running", pid: 555 });

    const res = await handler("memory_worker_stop")();

    expect(enabledCalls).toEqual([false]);
    expect(res).toEqual({
      workerWasRunning: true,
      pid: 555,
      workerEnabled: false,
    });
  });

  test("disables the flag and succeeds when no worker is running", async () => {
    stopImpl = () => ({ status: "not_running" });

    const res = await handler("memory_worker_stop")();

    expect(enabledCalls).toEqual([false]);
    expect(res).toEqual({ workerWasRunning: false, workerEnabled: false });
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("memory_worker_status", () => {
  test("reports the sync runner down when the worker flag is on", async () => {
    workerProbe = { status: "running", pid: 321 };
    configEnabled = true;

    const res = await handler("memory_worker_status")();

    expect(res).toEqual({
      status: "running",
      pid: 321,
      workerEnabled: true,
      syncRunner: { status: "not_running" },
      embedding: {
        enabled: true,
        degraded: false,
        provider: "openai",
        model: "text-embedding-3-small",
        reason: null,
      },
    });
  });

  test("derives the sync runner (with the daemon's pid) from the flag being off", async () => {
    workerProbe = { status: "not_running" };
    configEnabled = false;

    const res = await handler("memory_worker_status")();

    expect(res).toEqual({
      status: "not_running",
      workerEnabled: false,
      syncRunner: { status: "running", pid: process.pid },
      embedding: {
        enabled: true,
        degraded: false,
        provider: "openai",
        model: "text-embedding-3-small",
        reason: null,
      },
    });
  });

  test("surfaces a resolved embedding backend", async () => {
    workerProbe = { status: "not_running" };
    configEnabled = false;
    backendStatus = {
      enabled: true,
      degraded: false,
      provider: "gemini",
      model: "text-embedding-004",
      reason: null,
    };

    const res = await handler("memory_worker_status")();

    expect(res).toMatchObject({
      embedding: { degraded: false, provider: "gemini" },
    });
  });

  test("surfaces the local embedding backend (the default non-platform provider)", async () => {
    workerProbe = { status: "not_running" };
    configEnabled = false;
    backendStatus = {
      enabled: true,
      degraded: false,
      provider: "local",
      model: "Xenova/all-MiniLM-L6-v2",
      reason: null,
    };

    const res = await handler("memory_worker_status")();

    expect(res).toMatchObject({
      embedding: { degraded: false, provider: "local" },
    });
    // The wire value "local" must satisfy the documented response contract.
    expect(
      embeddingStatusSchema.safeParse(
        (res as { embedding: unknown }).embedding,
      ).success,
    ).toBe(true);
  });

  test("surfaces a degraded embedding backend with a reason when none is configured", async () => {
    workerProbe = { status: "not_running" };
    configEnabled = false;
    backendStatus = {
      enabled: true,
      degraded: true,
      provider: null,
      model: null,
      reason: "No embedding backend configured",
    };

    const res = await handler("memory_worker_status")();

    expect(res).toMatchObject({
      embedding: {
        enabled: true,
        degraded: true,
        provider: null,
        model: null,
        reason: "No embedding backend configured",
      },
    });
  });

  test("reports the sync runner down when memory is disabled", async () => {
    workerProbe = { status: "not_running" };
    configEnabled = false;
    memoryEnabled = false;

    const res = await handler("memory_worker_status")();

    expect(res).toMatchObject({
      workerEnabled: false,
      syncRunner: { status: "not_running" },
    });
  });
});
