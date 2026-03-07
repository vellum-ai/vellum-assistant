import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockGatewayInternalBaseUrl = "http://127.0.0.1:7830";
let mockIsContainerized = false;
let mockLockfile: Record<string, unknown> | null = null;

mock.module("../config/env.js", () => ({
  getGatewayInternalBaseUrl: () => mockGatewayInternalBaseUrl,
}));

mock.module("../config/env-registry.js", () => ({
  getIsContainerized: () => mockIsContainerized,
}));

mock.module("../util/platform.js", () => ({
  readLockfile: () => mockLockfile,
}));

import {
  ensureLocalGatewayReady,
  probeLocalGatewayHealth,
} from "../runtime/local-gateway-health.js";

describe("local gateway health", () => {
  beforeEach(() => {
    mockGatewayInternalBaseUrl = "http://127.0.0.1:7830";
    mockIsContainerized = false;
    mockLockfile = {
      assistants: [
        {
          assistantId: "local-dev",
          cloud: "local",
          hatchedAt: "2026-03-07T00:00:00.000Z",
        },
      ],
    };
  });

  test("probeLocalGatewayHealth returns healthy result when /healthz succeeds", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      requests.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await probeLocalGatewayHealth({
      fetchImpl,
      timeoutMs: 50,
    });

    expect(requests).toEqual(["http://127.0.0.1:7830/healthz"]);
    expect(result).toEqual({
      target: "http://127.0.0.1:7830",
      healthy: true,
      localDeployment: true,
    });
  });

  test("probeLocalGatewayHealth returns an unhealthy result when /healthz fails", async () => {
    const fetchImpl: typeof fetch = (async (): Promise<Response> => {
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;

    const result = await probeLocalGatewayHealth({
      fetchImpl,
      timeoutMs: 50,
    });

    expect(result).toEqual({
      target: "http://127.0.0.1:7830",
      healthy: false,
      localDeployment: true,
      error: "Gateway health check returned HTTP 503",
    });
  });

  test("ensureLocalGatewayReady runs recovery for local assistants until the gateway becomes healthy", async () => {
    const healthStatuses = [503, 503, 200];
    const fetchImpl: typeof fetch = (async (): Promise<Response> => {
      const status = healthStatuses.shift() ?? 200;
      return new Response(status === 200 ? "ok" : "unavailable", { status });
    }) as unknown as typeof fetch;

    const wakeCalls: number[] = [];
    const result = await ensureLocalGatewayReady({
      fetchImpl,
      timeoutMs: 50,
      pollTimeoutMs: 100,
      pollIntervalMs: 0,
      sleepImpl: async () => {},
      runWakeCommand: async () => {
        wakeCalls.push(Date.now());
        return { exitCode: 0, stdout: "Wake complete.", stderr: "" };
      },
    });

    expect(wakeCalls).toHaveLength(1);
    expect(result).toEqual({
      target: "http://127.0.0.1:7830",
      healthy: true,
      localDeployment: true,
      recovered: true,
      recoveryAttempted: true,
      recoverySkipped: false,
    });
  });

  test("ensureLocalGatewayReady skips recovery for non-local assistants", async () => {
    mockLockfile = {
      assistants: [
        {
          assistantId: "remote-prod",
          cloud: "gcp",
          hatchedAt: "2026-03-07T00:00:00.000Z",
        },
      ],
    };

    const fetchImpl: typeof fetch = (async (): Promise<Response> => {
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;

    let wakeCallCount = 0;
    const result = await ensureLocalGatewayReady({
      fetchImpl,
      timeoutMs: 50,
      runWakeCommand: async () => {
        wakeCallCount++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(wakeCallCount).toBe(0);
    expect(result).toEqual({
      target: "http://127.0.0.1:7830",
      healthy: false,
      localDeployment: false,
      error: "Gateway health check returned HTTP 503",
      recovered: false,
      recoveryAttempted: false,
      recoverySkipped: true,
    });
  });
});
