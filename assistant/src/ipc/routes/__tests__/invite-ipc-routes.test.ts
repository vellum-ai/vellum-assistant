/**
 * The gateway-facing invite redemption methods are IPC-only: registered on
 * the assistant IPC server by operationId, and absent from the shared HTTP
 * route set / `get_route_schema`. Relocating them out of `ROUTES` (per the
 * documented IPC-only pattern) is what structurally guarantees they can never
 * reach the gateway's HTTP IPC proxy route schema.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => undefined,
  setSecureKeyAsync: async () => {},
  deleteSecureKeyAsync: async () => {},
}));

import { ROUTES as contactRoutes } from "../../../runtime/routes/contact-routes.js";
import { INVITE_IPC_METHODS } from "../invite-ipc-routes.js";
import { routeDefinitionsToIpcMethods } from "../route-adapter.js";

const INVITE_IPC_OPERATION_IDS = [
  "invites_redeem_voice",
  "invites_redeem_token",
] as const;

describe("invite IPC-only methods", () => {
  test("are reachable on the IPC surface by operationId", () => {
    for (const operationId of INVITE_IPC_OPERATION_IDS) {
      expect(typeof INVITE_IPC_METHODS[operationId]).toBe("function");
    }
  });

  test("are NOT in the shared contact ROUTES array", () => {
    const sharedIds = new Set(contactRoutes.map((r) => r.operationId));
    for (const operationId of INVITE_IPC_OPERATION_IDS) {
      expect(sharedIds.has(operationId)).toBe(false);
    }
  });

  test("are NOT in the gateway-facing get_route_schema", async () => {
    const ipcMethods = routeDefinitionsToIpcMethods(contactRoutes);
    const meta = ipcMethods.find((r) => r.operationId === "get_route_schema");
    expect(meta).toBeDefined();
    const schema = (await meta!.handler({})) as { operationId: string }[];
    const schemaIds = new Set(schema.map((e) => e.operationId));
    for (const operationId of INVITE_IPC_OPERATION_IDS) {
      expect(schemaIds.has(operationId)).toBe(false);
    }
  });
});
