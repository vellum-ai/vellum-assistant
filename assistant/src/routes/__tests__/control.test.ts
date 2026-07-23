/**
 * Tests for the route host daemon-lifecycle entry points.
 *
 * `startRouteHost` is gated on `userRoutes.host.enabled` (opt-in pre-warm);
 * `stopRouteHost` signals the host if running and never throws. The config,
 * spawn, and stop dependencies are mocked so the tests assert the wrappers'
 * gating and error-swallowing, not the underlying PID-file mechanics.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as realLoader from "../../config/loader.js";
import * as realLogger from "../../util/logger.js";
import * as realWorkerProcess from "../../util/worker-process.js";

let enabled = false;
let spawnArgs: Array<{ options?: { detached?: boolean } }> = [];
let stopStatus: { status: "running" | "not_running"; pid?: number } = {
  status: "not_running",
};
let stopCalls = 0;
let stopThrows: Error | null = null;

mock.module("../../config/loader.js", () => ({
  ...realLoader,
  getConfigReadOnly: () => ({ userRoutes: { host: { enabled } } }),
}));

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
mock.module("../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
}));

mock.module("../../util/worker-process.js", () => ({
  ...realWorkerProcess,
  spawnWorkerProcess: async (args: { options?: { detached?: boolean } }) => {
    spawnArgs.push(args);
    return { pid: 4242, alreadyRunning: false };
  },
  stopWorkerProcess: () => {
    stopCalls++;
    if (stopThrows) {
      throw stopThrows;
    }
    return stopStatus;
  },
  probeWorkerPidFile: () => stopStatus,
}));

const { startRouteHost, stopRouteHost } = await import("../control.js");

beforeEach(() => {
  enabled = false;
  spawnArgs = [];
  stopStatus = { status: "not_running" };
  stopCalls = 0;
  stopThrows = null;
});

describe("startRouteHost", () => {
  test("is a no-op when the route host is disabled", async () => {
    enabled = false;
    startRouteHost();
    await Promise.resolve();
    expect(spawnArgs).toHaveLength(0);
  });

  test("spawns the host as a daemon child when enabled", async () => {
    enabled = true;
    startRouteHost();
    await Promise.resolve();
    expect(spawnArgs).toHaveLength(1);
    expect(spawnArgs[0].options?.detached).toBe(false);
  });
});

describe("stopRouteHost", () => {
  test("signals the host when it is running", () => {
    stopStatus = { status: "running", pid: 555 };
    stopRouteHost();
    expect(stopCalls).toBe(1);
  });

  test("is a no-op (never throws) when the host is not running", () => {
    stopStatus = { status: "not_running" };
    expect(() => stopRouteHost()).not.toThrow();
    expect(stopCalls).toBe(1);
  });

  test("swallows errors from the stop call", () => {
    stopThrows = new Error("kill EPERM");
    expect(() => stopRouteHost()).not.toThrow();
  });
});
