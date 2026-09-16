/**
 * Timing coverage for the schedule-worker MCP bootstrap and reload helpers.
 *
 * The worker entrypoint cannot be imported (it calls process.exit). These
 * tests drive the extracted helpers with a delayed start so a due schedule
 * cannot observe a ready surface before registration settles.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { EMPTY_MCP_STARTUP_SNAPSHOT } from "../../mcp/tool-caps.js";
import {
  getScheduleToolSurfaceState,
  isScheduleToolSurfaceReady,
  resetScheduleToolSurfaceReadinessForTests,
} from "../tool-surface-readiness.js";
import {
  bootstrapScheduleWorkerMcp,
  reloadScheduleWorkerMcp,
} from "../worker-mcp.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  resetScheduleToolSurfaceReadinessForTests();
});

describe("bootstrapScheduleWorkerMcp", () => {
  test("stays unready past the grace period until start settles", async () => {
    const gate = deferred<typeof EMPTY_MCP_STARTUP_SNAPSHOT>();
    const snapshot = {
      ...EMPTY_MCP_STARTUP_SNAPSHOT,
      configuredServerCount: 8,
      connectedServerCount: 8,
      registeredToolCount: 3,
    };

    const boot = bootstrapScheduleWorkerMcp({
      start: () => gate.promise,
      graceMs: 20,
    });
    await boot;

    expect(isScheduleToolSurfaceReady()).toBe(false);
    expect(getScheduleToolSurfaceState()).toBe("starting");

    gate.resolve(snapshot);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(isScheduleToolSurfaceReady()).toBe(true);
    expect(getScheduleToolSurfaceState()).toBe("ready");
  });

  test("marks ready when start finishes before the grace deadline", async () => {
    await bootstrapScheduleWorkerMcp({
      start: async () => ({
        ...EMPTY_MCP_STARTUP_SNAPSHOT,
        registeredToolCount: 2,
      }),
      graceMs: 50,
    });

    expect(isScheduleToolSurfaceReady()).toBe(true);
  });
});

describe("reloadScheduleWorkerMcp", () => {
  test("is not ready while reload is in flight", async () => {
    const gate = deferred<typeof EMPTY_MCP_STARTUP_SNAPSHOT>();
    const reloading = reloadScheduleWorkerMcp({
      restart: () => gate.promise,
    });

    expect(getScheduleToolSurfaceState()).toBe("reloading");
    expect(isScheduleToolSurfaceReady()).toBe(false);

    gate.resolve({
      ...EMPTY_MCP_STARTUP_SNAPSHOT,
      registeredToolCount: 4,
    });
    await reloading;

    expect(isScheduleToolSurfaceReady()).toBe(true);
  });

  test("failed reload does not stay in reloading", async () => {
    await expect(
      reloadScheduleWorkerMcp({
        restart: async () => {
          throw new Error("reconnect failed");
        },
      }),
    ).rejects.toThrow("reconnect failed");

    expect(getScheduleToolSurfaceState()).toBe("ready");
    expect(isScheduleToolSurfaceReady()).toBe(true);
  });
});
