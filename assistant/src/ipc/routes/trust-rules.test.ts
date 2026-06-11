/**
 * Unit tests for the trust rule IPC proxy routes.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type IpcCall = {
  method: string;
  params?: Record<string, unknown>;
};

let ipcCalls: IpcCall[] = [];
let ipcResult: unknown = { rules: [] };
let ipcError: Error | undefined;

const ipcCallPersistentMock = mock(
  async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    if (ipcError) throw ipcError;
    return ipcResult;
  },
);

mock.module("../gateway-client.js", () => ({
  ipcCallPersistent: ipcCallPersistentMock,
}));

import { ROUTES as trustRuleRoutes } from "../../runtime/routes/trust-rules-routes.js";

function findRoute(method: string) {
  const route = trustRuleRoutes.find((r) => r.operationId === method);
  if (!route) throw new Error(`Route not found: ${method}`);
  return route;
}

describe("trustRuleRoutes", () => {
  beforeEach(() => {
    ipcCalls = [];
    ipcResult = { rules: [] };
    ipcError = undefined;
    ipcCallPersistentMock.mockClear();
  });

  describe("trust_rules_list", () => {
    test("no params calls trust_rules_list with empty params", async () => {
      const route = findRoute("trust_rules_list");
      await route.handler({ body: {} });

      expect(ipcCalls).toEqual([{ method: "trust_rules_list", params: {} }]);
    });

    test("{ tool: 'bash' } is forwarded", async () => {
      const route = findRoute("trust_rules_list");
      await route.handler({ body: { tool: "bash" } });

      expect(ipcCalls).toEqual([
        { method: "trust_rules_list", params: { tool: "bash" } },
      ]);
    });

    test("{ include_all: true } is forwarded", async () => {
      const route = findRoute("trust_rules_list");
      await route.handler({ body: { include_all: true } });

      expect(ipcCalls).toEqual([
        { method: "trust_rules_list", params: { include_all: true } },
      ]);
    });

    test("{ origin: 'user_defined' } is forwarded", async () => {
      const route = findRoute("trust_rules_list");
      await route.handler({ body: { origin: "user_defined" } });

      expect(ipcCalls).toEqual([
        {
          method: "trust_rules_list",
          params: { origin: "user_defined" },
        },
      ]);
    });

    test("returns the parsed gateway IPC response", async () => {
      ipcResult = {
        rules: [
          {
            id: "rule-123",
            tool: "bash",
            pattern: "echo hello",
            risk: "low",
            description: "Allow echo hello",
            origin: "user_defined",
            userModified: false,
            deleted: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };

      const route = findRoute("trust_rules_list");
      const result = await route.handler({ body: {} });

      expect(result).toEqual(ipcResult);
    });
  });

  describe("error path", () => {
    test("gateway IPC error is propagated", async () => {
      ipcError = new Error("Gateway IPC call timed out");

      const route = findRoute("trust_rules_list");
      await expect(route.handler({ body: {} })).rejects.toThrow(
        "Gateway IPC call timed out",
      );
    });
  });
});
