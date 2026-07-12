/**
 * Tests for the schedule worker status route.
 *
 * The route handler runs inside the daemon and reports the worker process
 * liveness from its PID file. We mock schedule worker-control so the test
 * asserts the handler shape.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let workerProbe: { status: "running" | "not_running"; pid?: number } = {
  status: "not_running",
};

mock.module("../../../schedule/worker-control.js", () => ({
  probeScheduleWorker: () => workerProbe,
}));

const { ROUTES } = await import("../schedule-worker-routes.js");

function handler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`route ${operationId} not registered`);
  }
  return route.handler as () => Record<string, unknown>;
}

beforeEach(() => {
  workerProbe = { status: "not_running" };
});

describe("schedules_worker_status", () => {
  test("reports a running worker with its PID", () => {
    workerProbe = { status: "running", pid: 321 };

    const res = handler("schedules_worker_status")();

    expect(res).toEqual({ status: "running", pid: 321 });
  });

  test("reports not_running when the worker process is absent", () => {
    workerProbe = { status: "not_running" };

    const res = handler("schedules_worker_status")();

    expect(res).toEqual({ status: "not_running" });
  });
});
