/**
 * Unit tests for the gateway_logs_tail route handler.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { ZodError } from "zod";

type IpcCall = {
  method: string;
  params?: Record<string, unknown>;
};

let ipcCalls: IpcCall[] = [];
let ipcResult: unknown = { lines: [], truncated: false };
let ipcError: Error | undefined;

const ipcCallPersistentMock = mock(
  async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    if (ipcError) throw ipcError;
    return ipcResult;
  },
);

mock.module("../../../ipc/gateway-client.js", () => ({
  ipcCallPersistent: ipcCallPersistentMock,
}));

import { ROUTES } from "../gateway-log-routes.js";

const gatewayLogsTailRoute = ROUTES.find(
  (r) => r.operationId === "gateway_logs_tail",
)!;

describe("gateway_logs_tail route", () => {
  beforeEach(() => {
    ipcCalls = [];
    ipcResult = { lines: [], truncated: false };
    ipcError = undefined;
    ipcCallPersistentMock.mockClear();
  });

  test("route is registered with correct operationId, method, and endpoint", () => {
    expect(gatewayLogsTailRoute).toBeDefined();
    expect(gatewayLogsTailRoute.operationId).toBe("gateway_logs_tail");
    expect(gatewayLogsTailRoute.method).toBe("GET");
    expect(gatewayLogsTailRoute.endpoint).toBe("gateway/logs/tail");
  });

  test("calls gateway IPC with all typed params from body", async () => {
    await gatewayLogsTailRoute.handler({
      body: { n: 5, level: "warn", module: "mcp" },
    });

    expect(ipcCalls).toEqual([
      {
        method: "gateway_logs_tail",
        params: { n: 5, level: "warn", module: "mcp" },
      },
    ]);
  });

  test("returns the parsed IPC response body", async () => {
    ipcResult = {
      lines: [{ msg: "hello", level: 40 }],
      truncated: false,
    };

    const result = await gatewayLogsTailRoute.handler({
      body: { n: 5, level: "warn", module: "mcp" },
    });

    expect(result).toEqual(ipcResult);
  });

  test("calls gateway IPC with empty params when no filters are provided", async () => {
    await gatewayLogsTailRoute.handler({});

    expect(ipcCalls).toEqual([{ method: "gateway_logs_tail", params: {} }]);
  });

  test("sends only n when only n is provided", async () => {
    await gatewayLogsTailRoute.handler({ body: { n: 5 } });

    expect(ipcCalls).toEqual([
      { method: "gateway_logs_tail", params: { n: 5 } },
    ]);
  });

  test("propagates gateway IPC errors", async () => {
    ipcError = new Error("Gateway IPC socket disconnected");

    await expect(gatewayLogsTailRoute.handler({ body: {} })).rejects.toThrow(
      "Gateway IPC socket disconnected",
    );
  });

  test("rejects malformed gateway IPC responses", async () => {
    ipcResult = { entries: [] };

    await expect(
      gatewayLogsTailRoute.handler({ body: {} }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  test("level: 'INVALID' is rejected before calling gateway IPC", async () => {
    await expect(
      gatewayLogsTailRoute.handler({
        body: { level: "INVALID" },
      }),
    ).rejects.toBeInstanceOf(ZodError);

    expect(ipcCalls).toEqual([]);
  });

  test("n: 0 is rejected before calling gateway IPC", async () => {
    await expect(
      gatewayLogsTailRoute.handler({ body: { n: 0 } }),
    ).rejects.toBeInstanceOf(ZodError);

    expect(ipcCalls).toEqual([]);
  });

  test("n: 1001 is rejected before calling gateway IPC", async () => {
    await expect(
      gatewayLogsTailRoute.handler({ body: { n: 1001 } }),
    ).rejects.toBeInstanceOf(ZodError);

    expect(ipcCalls).toEqual([]);
  });

  test("module: '' is accepted", async () => {
    await gatewayLogsTailRoute.handler({ body: { module: "" } });

    expect(ipcCalls).toEqual([
      { method: "gateway_logs_tail", params: { module: "" } },
    ]);
  });

  test("uses queryParams when provided and coerces n", async () => {
    await gatewayLogsTailRoute.handler({
      queryParams: { n: "7", level: "info", module: "cors" },
      body: { n: 1, level: "error" },
    });

    expect(ipcCalls).toEqual([
      {
        method: "gateway_logs_tail",
        params: { n: 7, level: "info", module: "cors" },
      },
    ]);
  });
});
