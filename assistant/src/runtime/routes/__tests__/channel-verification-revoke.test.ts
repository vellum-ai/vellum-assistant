/**
 * Tests for the verification-revoke route relay.
 *
 * The revoke route downgrades the channel's ACL status through the gateway
 * (source of truth) via `ipcCallPersistent("mark_channel_revoked", ...)` while
 * keeping session teardown (`cancelOutbound`, `revokePendingSessions`)
 * assistant-side. The gateway enforces the guardian guard; a rejected guardian
 * downgrade surfaces here as a relayed IpcCallError.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { IpcCallError } from "@vellumai/gateway-client/ipc-client";

type IpcCall = { method: string; params?: Record<string, unknown> };

let ipcCalls: IpcCall[] = [];
let ipcError: Error | undefined;

const ipcCallPersistentMock = mock(
  async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    if (ipcError) throw ipcError;
    return {
      ok: true,
      didWrite: true,
      channel: {
        id: (params?.contactChannelId as string) ?? "ch1",
        contactId: "c1",
        type: "telegram",
        address: "addr",
        status: "revoked",
        revokedReason: (params?.reason as string) ?? null,
      },
    };
  },
);

const actualGatewayClient = await import("../../../ipc/gateway-client.js");
mock.module("../../../ipc/gateway-client.js", () => ({
  ...actualGatewayClient,
  ipcCallPersistent: ipcCallPersistentMock,
}));

// Session teardown — assert these still run locally on every revoke.
const cancelOutboundMock = mock((_args: { channel: string }) => {});
const actualOutboundActions = await import(
  "../../verification-outbound-actions.js"
);
mock.module("../../verification-outbound-actions.js", () => ({
  ...actualOutboundActions,
  cancelOutbound: cancelOutboundMock,
}));

const revokePendingSessionsMock = mock((_channel: string) => {});
let guardianBinding:
  | {
      guardianExternalUserId: string;
      guardianDeliveryChatId?: string;
    }
  | null = null;
const actualVerificationService = await import(
  "../../channel-verification-service.js"
);
mock.module("../../channel-verification-service.js", () => ({
  ...actualVerificationService,
  revokePendingSessions: revokePendingSessionsMock,
  getGuardianBinding: mock(() => guardianBinding),
}));

// Contact-store lookup that resolves the guardian's channel to downgrade.
let contactChannel: { id: string; status: string } | null = null;
const actualContactStore = await import("../../../contacts/contact-store.js");
mock.module("../../../contacts/contact-store.js", () => ({
  ...actualContactStore,
  findContactChannel: mock(() =>
    contactChannel ? { channel: contactChannel, contact: { id: "c1" } } : null,
  ),
}));

// Guard: the local ACL write paths must never run on the relayed revoke.
const localAclWrite = mock(() => {
  throw new Error("local ACL write must not happen on relayed revoke");
});
const actualContactsWrite = await import("../../../contacts/contacts-write.js");
mock.module("../../../contacts/contacts-write.js", () => ({
  ...actualContactsWrite,
  revokeMember: localAclWrite,
  revokeGuardianBinding: localAclWrite,
}));

const { ROUTES } = await import("../channel-verification-routes.js");

const revokeHandler = ROUTES.find(
  (r) => r.operationId === "channel_verification_sessions_revoke",
)!.handler;

describe("verification revoke relay", () => {
  beforeEach(() => {
    ipcCalls = [];
    ipcError = undefined;
    guardianBinding = {
      guardianExternalUserId: "guardian-user",
      guardianDeliveryChatId: "chat-1",
    };
    contactChannel = { id: "ch1", status: "active" };
    ipcCallPersistentMock.mockClear();
    cancelOutboundMock.mockClear();
    revokePendingSessionsMock.mockClear();
    localAclWrite.mockClear();
  });

  test("relays the downgrade outcome to the gateway and tears down sessions locally", async () => {
    const result = (await revokeHandler({
      body: { channel: "telegram" },
    })) as { success: boolean; bound: boolean; channel: string };

    // ACL downgrade relayed to the gateway (source of truth).
    expect(ipcCalls).toEqual([
      {
        method: "mark_channel_revoked",
        params: {
          contactChannelId: "ch1",
          reason: "guardian_binding_revoked",
        },
      },
    ]);

    // Session teardown stays assistant-side.
    expect(cancelOutboundMock).toHaveBeenCalledTimes(1);
    expect(revokePendingSessionsMock).toHaveBeenCalledTimes(1);

    // No assistant-side ACL fallback.
    expect(localAclWrite).not.toHaveBeenCalled();

    expect(result.success).toBe(true);
    expect(result.bound).toBe(false);
  });

  test("guardian guard rejection from the gateway surfaces as an error", async () => {
    ipcError = new IpcCallError("Cannot downgrade a guardian channel.", {
      statusCode: 409,
      errorCode: "CONFLICT",
    });

    let thrown: { statusCode?: number; message: string } | undefined;
    try {
      await revokeHandler({ body: { channel: "telegram" } });
    } catch (err) {
      thrown = err as { statusCode?: number; message: string };
    }

    expect(thrown).toBeDefined();
    expect(thrown!.statusCode).toBe(409);
    // Teardown still ran before the relay rejected.
    expect(cancelOutboundMock).toHaveBeenCalledTimes(1);
    expect(revokePendingSessionsMock).toHaveBeenCalledTimes(1);
    expect(localAclWrite).not.toHaveBeenCalled();
  });

  test("no binding present: tears down sessions and skips the relay", async () => {
    guardianBinding = null;

    const result = (await revokeHandler({
      body: { channel: "telegram" },
    })) as { success: boolean; bound: boolean };

    expect(ipcCalls).toEqual([]);
    expect(cancelOutboundMock).toHaveBeenCalledTimes(1);
    expect(revokePendingSessionsMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.bound).toBe(false);
  });

  test("skips the relay when the resolved channel is already revoked", async () => {
    contactChannel = { id: "ch1", status: "revoked" };

    await revokeHandler({ body: { channel: "telegram" } });

    expect(ipcCalls).toEqual([]);
    expect(cancelOutboundMock).toHaveBeenCalledTimes(1);
    expect(revokePendingSessionsMock).toHaveBeenCalledTimes(1);
  });
});
