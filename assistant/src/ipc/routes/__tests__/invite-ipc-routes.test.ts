/**
 * The gateway-facing invite methods are IPC-only: registered on the
 * assistant IPC server by operationId, and absent from the shared HTTP
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

// Wiring-only: the real composition (guardian-name resolution, contact
// lookups) needs a migrated DB and is unit-tested in invite-routes-http.
// A passthrough keeps this suite asserting envelope + payload retention.
mock.module("../../../runtime/invite-service.js", () => ({
  composeInvitePresentation: async (params: {
    invite: Record<string, unknown>;
  }) => params.invite,
}));

import { ROUTES as contactRoutes } from "../../../runtime/routes/contact-routes.js";
import { INVITE_IPC_METHODS } from "../invite-ipc-routes.js";
import { routeDefinitionsToIpcMethods } from "../route-adapter.js";

const INVITE_IPC_OPERATION_IDS = [
  "invite_redeemed",
  "invites_compose_presentation",
] as const;

// Redemption is gateway-native: the daemon must expose NO redeem IPC methods
// (the daemon redeem route relays to the gateway's `invites_redeem` instead).
const REMOVED_REDEEM_OPERATION_IDS = [
  "invites_redeem_voice",
  "invites_redeem_token",
] as const;

describe("invite IPC-only methods", () => {
  test("are reachable on the IPC surface by operationId", () => {
    for (const operationId of INVITE_IPC_OPERATION_IDS) {
      expect(typeof INVITE_IPC_METHODS[operationId]).toBe("function");
    }
  });

  test("expose no daemon-local redeem methods (redemption is gateway-native)", () => {
    for (const operationId of REMOVED_REDEEM_OPERATION_IDS) {
      expect(INVITE_IPC_METHODS[operationId]).toBeUndefined();
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

// Wiring-only coverage: composition behavior itself is unit-tested against
// the real `composeInvitePresentation` in `invite-routes-http.test.ts`, and
// the gateway HTTP merge is covered in the gateway proxy suite. Asserting
// only merge-retention here keeps this file independent of the
// `invite-service` module mocks other suites install in a shared bun process.
describe("invites_compose_presentation", () => {
  test("returns an { invite } envelope preserving the one-time mint payload", async () => {
    const result = (await INVITE_IPC_METHODS.invites_compose_presentation({
      body: {
        contactId: "ct-1",
        invite: {
          id: "inv-1",
          sourceChannel: "phone",
          friendName: "Sam Example",
          voiceCode: "123456",
        },
      },
    })) as { invite: Record<string, unknown> };

    expect(result.invite.id).toBe("inv-1");
    expect(result.invite.voiceCode).toBe("123456");
    expect(result.invite.friendName).toBe("Sam Example");
  });

  test("rejects a payload without an invite object", async () => {
    await expect(
      Promise.resolve(
        INVITE_IPC_METHODS.invites_compose_presentation({
          body: { contactId: "ct-1" },
        }),
      ),
    ).rejects.toThrow();
  });
});
