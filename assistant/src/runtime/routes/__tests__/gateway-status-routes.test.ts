/**
 * Unit tests for the gateway_status route handler.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { ServiceUnavailableError } from "../errors.js";

let ipcResult: unknown = null;
let ipcError: Error | undefined;
let ipcCallCount = 0;

const ipcGetVelayStatusMock = mock(async () => {
  ipcCallCount += 1;
  if (ipcError) throw ipcError;
  return ipcResult;
});

mock.module("../../../ipc/gateway-client.js", () => ({
  ipcGetVelayStatus: ipcGetVelayStatusMock,
}));

import { ROUTES } from "../gateway-status-routes.js";

const gatewayStatusRoute = ROUTES.find(
  (r) => r.operationId === "gateway_status",
)!;

describe("gateway_status route", () => {
  beforeEach(() => {
    ipcResult = null;
    ipcError = undefined;
    ipcCallCount = 0;
    ipcGetVelayStatusMock.mockClear();
  });

  test("route is registered with correct operationId, method, and endpoint", () => {
    expect(gatewayStatusRoute).toBeDefined();
    expect(gatewayStatusRoute.operationId).toBe("gateway_status");
    expect(gatewayStatusRoute.method).toBe("GET");
    expect(gatewayStatusRoute.endpoint).toBe("gateway/status");
  });

  test("returns the tunnel URL when a tunnel is connected", async () => {
    ipcResult = { connected: true, publicUrl: "https://abc123.vellum.ai" };

    const result = await gatewayStatusRoute.handler({});

    expect(result).toEqual({ tunnel: "https://abc123.vellum.ai" });
  });

  test("returns {} when the tunnel is disconnected", async () => {
    ipcResult = { connected: false, publicUrl: null };

    const result = await gatewayStatusRoute.handler({});

    expect(result).toEqual({});
  });

  test("returns {} when connected but no public URL is registered yet", async () => {
    ipcResult = { connected: true, publicUrl: null };

    const result = await gatewayStatusRoute.handler({});

    expect(result).toEqual({});
  });

  test("errors with 503 when the gateway is unreachable", async () => {
    ipcResult = null;

    await expect(gatewayStatusRoute.handler({})).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  test("errors when the gateway IPC call throws (gateway not running)", async () => {
    ipcError = new Error("Gateway IPC socket disconnected");

    await expect(gatewayStatusRoute.handler({})).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(ipcCallCount).toBe(1);
  });
});
