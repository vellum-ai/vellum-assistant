/**
 * Tests for the gateway-backed voice-invite reader.
 *
 * Pins the asymmetric failure contract: detection returns `null` on ANY
 * failure (fail-soft — the caller falls to the unverified path), while
 * redemption returns the generic `invalid_or_expired` failure outcome on ANY
 * failure (fail-closed — no local fallback). Also pins the forwarded method,
 * params, and timeouts.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Controllable IPC mock ────────────────────────────────────────────────────

type IpcHandler = (params?: Record<string, unknown>) => unknown;

const ipcHandlers = new Map<string, IpcHandler>();
const ipcCallLog: Array<{
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}> = [];

mock.module("../../ipc/gateway-client.js", () => ({
  ipcCall: async (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => {
    ipcCallLog.push({ method, params, timeoutMs });
    const handler = ipcHandlers.get(method);
    return handler ? handler(params) : undefined;
  },
  ipcCallPersistent: async () => undefined,
  resetPersistentClient: () => {},
}));

import type {
  ActiveVoiceInvite,
  InviteRedemptionOutcome,
} from "@vellumai/gateway-client";

import {
  getActiveVoiceInvite,
  redeemVoiceInviteViaGateway,
} from "../gateway-invite-reader.js";

const CALLER = "+15555550100";
const CODE = "123456";

const VALID_INVITE = {
  inviteId: "inv-1",
  inviteeName: "Friend Name",
  guardianName: "Guardian Name",
  codeDigits: 6,
} satisfies ActiveVoiceInvite;

const VALID_OUTCOME = {
  inviteId: "inv-1",
  contactId: "c1",
  sourceChannel: "phone",
  memberExternalUserId: CALLER,
  memberExternalChatId: CALLER,
  displayName: "Friend Name",
  result: "redeemed",
} satisfies InviteRedemptionOutcome;

const FAILURE = { ok: false, reason: "invalid_or_expired" } as const;

beforeEach(() => {
  ipcHandlers.clear();
  ipcCallLog.length = 0;
});

describe("getActiveVoiceInvite", () => {
  test("returns the gateway-resolved invite on a valid response", async () => {
    ipcHandlers.set("get_active_voice_invite", () => ({
      invite: VALID_INVITE,
    }));

    expect(await getActiveVoiceInvite(CALLER)).toEqual(VALID_INVITE);
  });

  test("forwards the correct method, params, and timeout", async () => {
    ipcHandlers.set("get_active_voice_invite", () => ({ invite: null }));

    await getActiveVoiceInvite(CALLER);

    const call = ipcCallLog.find((c) => c.method === "get_active_voice_invite");
    expect(call?.params).toEqual({ callerExternalUserId: CALLER });
    expect(call?.timeoutMs).toBe(2_000);
  });

  test("returns null when the gateway reports no invite", async () => {
    ipcHandlers.set("get_active_voice_invite", () => ({ invite: null }));
    expect(await getActiveVoiceInvite(CALLER)).toBeNull();
  });

  test("returns null when IPC transport fails (undefined)", async () => {
    expect(await getActiveVoiceInvite(CALLER)).toBeNull();
  });

  test("returns null for a malformed invite shape", async () => {
    ipcHandlers.set("get_active_voice_invite", () => ({
      invite: { inviteId: 42 },
    }));
    expect(await getActiveVoiceInvite(CALLER)).toBeNull();
  });

  test("returns null when the IPC call throws", async () => {
    ipcHandlers.set("get_active_voice_invite", () => {
      throw new Error("socket exploded");
    });
    expect(await getActiveVoiceInvite(CALLER)).toBeNull();
  });

  test("returns null without dialing IPC when fromNumber is missing", async () => {
    expect(await getActiveVoiceInvite(undefined)).toBeNull();
    expect(await getActiveVoiceInvite("")).toBeNull();
    expect(ipcCallLog).toHaveLength(0);
  });
});

describe("redeemVoiceInviteViaGateway", () => {
  test("returns the success outcome on a valid response", async () => {
    ipcHandlers.set("redeem_voice_invite", () => ({
      ok: true,
      outcome: VALID_OUTCOME,
    }));

    expect(await redeemVoiceInviteViaGateway(CALLER, CODE)).toEqual({
      ok: true,
      outcome: VALID_OUTCOME,
    });
  });

  test("forwards the correct method and params", async () => {
    ipcHandlers.set("redeem_voice_invite", () => FAILURE);

    await redeemVoiceInviteViaGateway(CALLER, CODE);

    const call = ipcCallLog.find((c) => c.method === "redeem_voice_invite");
    expect(call?.params).toEqual({
      callerExternalUserId: CALLER,
      code: CODE,
    });
    expect(call?.timeoutMs).toBe(10_000);
  });

  test("passes through the gateway's generic failure", async () => {
    ipcHandlers.set("redeem_voice_invite", () => FAILURE);
    expect(await redeemVoiceInviteViaGateway(CALLER, CODE)).toEqual(FAILURE);
  });

  test("fails CLOSED when IPC transport fails (undefined)", async () => {
    expect(await redeemVoiceInviteViaGateway(CALLER, CODE)).toEqual(FAILURE);
  });

  test("fails CLOSED on a malformed response", async () => {
    ipcHandlers.set("redeem_voice_invite", () => ({ ok: true }));
    expect(await redeemVoiceInviteViaGateway(CALLER, CODE)).toEqual(FAILURE);
  });

  test("fails CLOSED when the IPC call throws", async () => {
    ipcHandlers.set("redeem_voice_invite", () => {
      throw new Error("socket exploded");
    });
    expect(await redeemVoiceInviteViaGateway(CALLER, CODE)).toEqual(FAILURE);
  });
});
