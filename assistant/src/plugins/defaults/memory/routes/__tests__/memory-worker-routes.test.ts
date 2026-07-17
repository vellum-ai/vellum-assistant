/**
 * Tests for the memory worker control routes (start / stop / status).
 *
 * The route handlers run inside the daemon and manage the worker process. We
 * mock worker-control + the embedding backend so the tests assert handler
 * behaviour:
 *   - start spawns as a daemon child (detached:false) and throws on failure.
 *   - stop signals the worker and reports its prior state.
 *   - status reports the worker process liveness + the embedding backend.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { getMemoryWorkerPidPath } from "../../../../../util/platform.js";

class FakeSpawnError extends Error {}

let spawnImpl: () => Promise<{ pid: number; alreadyRunning: boolean }>;
let spawnArgs: Array<{ detached?: boolean; terminateOnTimeout?: boolean }> = [];
let stopImpl: () => { status: "running" | "not_running"; pid?: number };
let workerProbe: { status: "running" | "not_running"; pid?: number } = {
  status: "not_running",
};
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

mock.module("../../worker-control.js", () => ({
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

mock.module(
  "../../../../../persistence/embeddings/embedding-backend.js",
  () => ({
    getMemoryBackendStatus: async () => backendStatus,
  }),
);

const { ROUTES, embeddingStatusSchema } =
  await import("../memory-worker-routes.js");

function handler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`route ${operationId} not registered`);
  return route.handler as () => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  spawnArgs = [];
  spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });
  stopImpl = () => ({ status: "not_running" });
  workerProbe = { status: "not_running" };
  backendStatus = {
    enabled: true,
    degraded: false,
    provider: "openai",
    model: "text-embedding-3-small",
    reason: null,
  };
});

describe("memory_worker_start", () => {
  test("spawns as a daemon child and returns the PID", async () => {
    spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });

    const res = await handler("memory_worker_start")();

    expect(spawnArgs).toEqual([{ detached: false }]);
    expect(res).toEqual({
      pid: 4242,
      alreadyRunning: false,
      pidPath: getMemoryWorkerPidPath(),
    });
  });

  test("reports an already-running worker without re-spawning", async () => {
    spawnImpl = async () => ({ pid: 99, alreadyRunning: true });

    const res = await handler("memory_worker_start")();

    expect(res).toMatchObject({ pid: 99, alreadyRunning: true });
  });

  test("throws when the spawn fails", async () => {
    spawnImpl = async () => {
      throw new FakeSpawnError("worker exited during startup");
    };

    await expect(handler("memory_worker_start")()).rejects.toThrow(
      "worker exited during startup",
    );
  });
});

describe("memory_worker_stop", () => {
  test("reports a signalled running worker", async () => {
    stopImpl = () => ({ status: "running", pid: 555 });

    const res = await handler("memory_worker_stop")();

    expect(res).toEqual({ workerWasRunning: true, pid: 555 });
  });

  test("succeeds when no worker is running", async () => {
    stopImpl = () => ({ status: "not_running" });

    const res = await handler("memory_worker_stop")();

    expect(res).toEqual({ workerWasRunning: false });
  });
});

describe("memory_worker_status", () => {
  test("reports a running worker with its PID and a resolved embedding backend", async () => {
    workerProbe = { status: "running", pid: 321 };

    const res = await handler("memory_worker_status")();

    expect(res).toEqual({
      status: "running",
      pid: 321,
      embedding: {
        enabled: true,
        degraded: false,
        provider: "openai",
        model: "text-embedding-3-small",
        reason: null,
      },
    });
  });

  test("reports not_running when the worker process is absent", async () => {
    workerProbe = { status: "not_running" };

    const res = await handler("memory_worker_status")();

    expect(res).toMatchObject({ status: "not_running" });
  });

  test("surfaces the local embedding backend (the default non-platform provider)", async () => {
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
      embeddingStatusSchema.safeParse((res as { embedding: unknown }).embedding)
        .success,
    ).toBe(true);
  });

  test("surfaces a degraded embedding backend with a reason when none is configured", async () => {
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
});
