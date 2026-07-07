/**
 * Tests for the verification-revoke route relay.
 *
 * The revoke route downgrades the channel's ACL status through the gateway
 * (source of truth) via `ipcCallPersistent("mark_channel_revoked", ...)`;
 * session teardown (`cancelOutbound`, `revokePendingSessions`) relays through
 * the gateway session client. The gateway enforces the guardian guard; a
 * rejected guardian downgrade surfaces here as a relayed IpcCallError.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianDelivery } from "@vellumai/gateway-client";
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

// Session teardown — assert these still run on every revoke.
const cancelOutboundMock = mock(async (_args: { channel: string }) => {});
const actualOutboundActions =
  await import("../../verification-outbound-actions.js");
mock.module("../../verification-outbound-actions.js", () => ({
  ...actualOutboundActions,
  cancelOutbound: cancelOutboundMock,
}));

const revokePendingSessionsMock = mock(async (_channel: string) => {});
const actualGatewaySessions =
  await import("../../../channels/gateway-verification-sessions.js");
mock.module("../../../channels/gateway-verification-sessions.js", () => ({
  ...actualGatewaySessions,
  revokePendingSessions: revokePendingSessionsMock,
}));

let guardianBinding: {
  guardianExternalUserId: string;
  guardianDeliveryChatId?: string;
} | null = null;
const actualVerificationService =
  await import("../../channel-verification-service.js");
mock.module("../../channel-verification-service.js", () => ({
  ...actualVerificationService,
  getGuardianBinding: mock(() => guardianBinding),
}));

// Contact-store lookup that resolves the guardian's channel to downgrade. The
// channel carries the type/address/externalChatId the gateway delivery is
// matched against (see deliveryForChannel).
let contactChannel: {
  id: string;
  status: string;
  type: string;
  address: string;
  externalChatId: string;
} | null = null;
const actualContactStore = await import("../../../contacts/contact-store.js");
mock.module("../../../contacts/contact-store.js", () => ({
  ...actualContactStore,
  findContactChannel: mock(() =>
    contactChannel ? { channel: contactChannel, contact: { id: "c1" } } : null,
  ),
}));

// Gateway delivery (ACL source of truth). The revoke gate relays only when the
// matching delivery is live (active/pending/unverified); already-revoked or a
// missing delivery short-circuits the relay.
let guardianDeliveries: GuardianDelivery[] | null = null;
mock.module("../../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: mock(async (input?: { channelTypes?: string[] }) => {
    if (guardianDeliveries == null) return null;
    if (!input?.channelTypes) return guardianDeliveries;
    return guardianDeliveries.filter((g) =>
      input.channelTypes!.includes(g.channelType),
    );
  }),
}));

// Contact-change notification — fired explicitly on relay success so open
// client views stop showing the channel as active after the gateway
// dual-writes it to "revoked".
const notifyContactsChangedMock = mock(() => {});
mock.module("../../../contacts/notify-contacts-changed.js", () => ({
  notifyContactsChanged: notifyContactsChangedMock,
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
    contactChannel = {
      id: "ch1",
      status: "active",
      type: "telegram",
      address: "guardian-user",
      externalChatId: "chat-1",
    };
    // Gateway delivery is live by default, so the revoke relay fires.
    guardianDeliveries = [
      {
        channelType: "telegram",
        contactId: "c1",
        address: "guardian-user",
        externalChatId: "chat-1",
        status: "active",
        verifiedAt: 1700000000,
      },
    ];
    ipcCallPersistentMock.mockClear();
    cancelOutboundMock.mockClear();
    revokePendingSessionsMock.mockClear();
    notifyContactsChangedMock.mockClear();
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

    // Invalidation emitted explicitly on relay success.
    expect(notifyContactsChangedMock).toHaveBeenCalledTimes(1);

    expect(result.success).toBe(true);
    expect(result.bound).toBe(false);
  });

  test("emits the invalidation on a successful relay", async () => {
    await revokeHandler({ body: { channel: "telegram" } });

    expect(ipcCalls).toHaveLength(1);
    expect(notifyContactsChangedMock).toHaveBeenCalledTimes(1);
  });

  test("malformed gateway response surfaces as an error", async () => {
    // Deliberately malformed shape: must fail schema validation, not pass.
    ipcCallPersistentMock.mockImplementationOnce(
      async () => ({ ok: "nope" }) as never,
    );

    let thrown: Error | undefined;
    try {
      await revokeHandler({ body: { channel: "telegram" } });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    // Invalidation must not fire when the relay response is invalid.
    expect(notifyContactsChangedMock).not.toHaveBeenCalled();
  });

  test("ok: false gateway response surfaces as an error", async () => {
    ipcCallPersistentMock.mockImplementationOnce(async (_m, params) => ({
      ok: false,
      didWrite: false,
      channel: {
        id: (params?.contactChannelId as string) ?? "ch1",
        contactId: "c1",
        type: "telegram",
        address: "addr",
        status: "active",
        revokedReason: "still_active",
      },
    }));

    let thrown: Error | undefined;
    try {
      await revokeHandler({ body: { channel: "telegram" } });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(notifyContactsChangedMock).not.toHaveBeenCalled();
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
    // Session teardown ran before the relay rejected.
    expect(cancelOutboundMock).toHaveBeenCalledTimes(1);
    expect(revokePendingSessionsMock).toHaveBeenCalledTimes(1);
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

  test("skips the relay when the gateway delivery is already revoked", async () => {
    // The gateway (source of truth) already shows the channel revoked, so the
    // redundant relay is skipped even though session/binding teardown runs.
    guardianDeliveries = [
      {
        channelType: "telegram",
        contactId: "c1",
        address: "guardian-user",
        externalChatId: "chat-1",
        status: "revoked",
        verifiedAt: 1700000000,
      },
    ];

    await revokeHandler({ body: { channel: "telegram" } });

    expect(ipcCalls).toEqual([]);
    expect(cancelOutboundMock).toHaveBeenCalledTimes(1);
    expect(revokePendingSessionsMock).toHaveBeenCalledTimes(1);
  });
});
