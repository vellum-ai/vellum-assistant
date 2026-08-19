import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ResourcePressureStatusResponseSchema } from "../api/responses/resource-pressure-status.js";

mock.module("../runtime/assistant-event-hub.js", () => ({
  AssistantEventHub: class {},
  broadcastMessage: () => {},
  capabilityForMessageType: () => undefined,
  assistantEventHub: {
    publish: async () => {},
  },
}));

mock.module("../util/container-cpu-sampler.js", () => ({
  getCachedContainerCpuPercent: () => 0,
  getCachedContainerCpuPercentOrNull: () => null,
  getAverageContainerCpuPercentOrNull: (_windowMs: number) => null,
}));

mock.module("../util/cgroup-cpu.js", () => ({
  getContainerCpuCores: () => 0,
}));

mock.module("../util/cgroup-memory.js", () => ({
  getContainerMemoryLimitBytes: () => null,
  getContainerMemoryUsageBytes: () => null,
  getContainerMemoryStat: () => null,
}));

const {
  __resetResourcePressureGuardForTests,
  evaluateResourcePressureNow,
  getResourcePressureStatus,
} = await import("../daemon/resource-pressure-guard.js");
const { ROUTES } =
  await import("../runtime/routes/resource-pressure-routes.js");

const statusRoute = ROUTES.find(
  (route) =>
    route.endpoint === "resource-pressure/status" && route.method === "GET",
);

async function callStatusRoute() {
  if (!statusRoute) {
    throw new Error("GET resource-pressure/status route not registered");
  }
  return ResourcePressureStatusResponseSchema.parse(
    await statusRoute.handler({}),
  );
}

const originalIsPlatform = process.env.IS_PLATFORM;

function restoreIsPlatform(): void {
  if (originalIsPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = originalIsPlatform;
  }
}

beforeEach(() => {
  __resetResourcePressureGuardForTests();
});

afterEach(() => {
  __resetResourcePressureGuardForTests();
  restoreIsPlatform();
});

describe("resource pressure routes", () => {
  test("registers the status route with a read-scoped auth policy", () => {
    expect(statusRoute).toBeDefined();
    expect(statusRoute?.policy?.requiredScopes).toEqual(["settings.read"]);
    expect(statusRoute?.policy?.allowedPrincipalTypes?.length).toBeGreaterThan(
      0,
    );
  });

  test("returns the disabled snapshot when the guard never started", async () => {
    delete process.env.IS_PLATFORM;

    const result = await callStatusRoute();

    expect(result.status.enabled).toBe(false);
    expect(result.status.state).toBe("disabled");
    expect(result.status.cpuPercent).toBeNull();
    expect(result.status.memoryPercent).toBeNull();
    expect(result.status.lastCheckedAt).toBeNull();
    expect(result.status.error).toBeNull();
  });

  test("returns the guard's current snapshot on platform", async () => {
    process.env.IS_PLATFORM = "true";
    evaluateResourcePressureNow({
      sampleCpuPercent: () => 42,
      sampleMemory: () => ({
        usageBytes: 500,
        limitBytes: 1000,
        reclaimableBytes: 100,
      }),
    });

    const result = await callStatusRoute();

    expect(result.status).toEqual(getResourcePressureStatus());
    expect(result.status.enabled).toBe(true);
    expect(result.status.state).toBe("ok");
    expect(result.status.cpuPercent).toBe(42);
    expect(result.status.memoryPercent).toBe(40);
    expect(result.status.lastCheckedAt).toBeTruthy();
  });
});
