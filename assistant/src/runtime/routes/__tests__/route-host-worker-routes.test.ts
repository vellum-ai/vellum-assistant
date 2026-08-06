/**
 * Tests for the route host worker control routes (start / stop / status).
 *
 * The handlers run inside the daemon and manage the route host process. We mock
 * the route host control surface so the tests assert handler behaviour:
 *   - start spawns as a daemon child (detached:false) and throws on failure.
 *   - stop signals the host and reports its prior state.
 *   - status reports the host process liveness.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { getProcPidPath } from "../../../util/platform.js";

class FakeSpawnError extends Error {}

let spawnImpl: () => Promise<{ pid: number; alreadyRunning: boolean }>;
let spawnArgs: Array<{ detached?: boolean; terminateOnTimeout?: boolean }> = [];
let stopImpl: () => { status: "running" | "not_running"; pid?: number };
let workerProbe: { status: "running" | "not_running"; pid?: number } = {
  status: "not_running",
};

mock.module("../../../routes/control.js", () => ({
  RouteHostSpawnError: FakeSpawnError,
  spawnRouteHostWorkerProcess: async (opts: {
    detached?: boolean;
    terminateOnTimeout?: boolean;
  }) => {
    spawnArgs.push(opts);
    return spawnImpl();
  },
  stopRouteHostWorkerProcess: () => stopImpl(),
  probeRouteHostWorker: () => workerProbe,
}));

const { ROUTES } = await import("../route-host-worker-routes.js");

function handler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`route ${operationId} not registered`);
  }
  return route.handler as () => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  spawnArgs = [];
  spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });
  stopImpl = () => ({ status: "not_running" });
  workerProbe = { status: "not_running" };
});

describe("routes_worker_start", () => {
  test("spawns as a daemon child and returns the PID", async () => {
    spawnImpl = async () => ({ pid: 4242, alreadyRunning: false });

    const res = await handler("routes_worker_start")();

    expect(spawnArgs).toEqual([{ detached: false }]);
    expect(res).toEqual({
      pid: 4242,
      alreadyRunning: false,
      pidPath: getProcPidPath("routes"),
    });
  });

  test("reports an already-running host without re-spawning", async () => {
    spawnImpl = async () => ({ pid: 99, alreadyRunning: true });

    const res = await handler("routes_worker_start")();

    expect(res).toMatchObject({ pid: 99, alreadyRunning: true });
  });

  test("throws when the spawn fails", async () => {
    spawnImpl = async () => {
      throw new FakeSpawnError("host exited during startup");
    };

    await expect(handler("routes_worker_start")()).rejects.toThrow(
      "host exited during startup",
    );
  });
});

describe("routes_worker_stop", () => {
  test("reports the host was running and its PID", async () => {
    stopImpl = () => ({ status: "running", pid: 555 });

    const res = await handler("routes_worker_stop")();

    expect(res).toEqual({ workerWasRunning: true, pid: 555 });
  });

  test("reports not-running when no host is up", async () => {
    stopImpl = () => ({ status: "not_running" });

    const res = await handler("routes_worker_stop")();

    expect(res).toEqual({ workerWasRunning: false });
  });
});

describe("routes_worker_status", () => {
  test("reports a running host with its PID", async () => {
    workerProbe = { status: "running", pid: 777 };

    const res = await handler("routes_worker_status")();

    expect(res).toEqual({ status: "running", pid: 777 });
  });

  test("reports not-running", async () => {
    workerProbe = { status: "not_running" };

    const res = await handler("routes_worker_status")();

    expect(res).toEqual({ status: "not_running" });
  });
});
