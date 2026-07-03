/**
 * Tests for the gateway-backed per-actor inbound trust reader.
 *
 * The reader returns `null` on ANY failure (transport failure, undefined,
 * malformed shape, thrown error); the Combo 9/10 consumer decides fail-open
 * vs fail-closed. These tests pin that contract plus the forwarded method +
 * params.
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

import type { TrustVerdict } from "@vellumai/gateway-client";

import { getInboundTrustVerdict } from "../inbound-trust-reader.js";

const METHOD = "resolve_inbound_trust";

const VALID_VERDICT = {
  trustClass: "trusted_contact",
  canonicalSenderId: "U_MEMBER",
  contactId: "c-member",
  status: "active",
} satisfies TrustVerdict;

describe("getInboundTrustVerdict", () => {
  beforeEach(() => {
    ipcHandlers.clear();
    ipcCallLog.length = 0;
  });

  test("returns the gateway-resolved verdict on a valid response", async () => {
    ipcHandlers.set(METHOD, () => ({ verdict: VALID_VERDICT }));

    const verdict = await getInboundTrustVerdict({
      channelType: "telegram",
      actorExternalId: "U_MEMBER",
    });

    expect(verdict).toEqual(VALID_VERDICT);
  });

  test("forwards the correct method, params, and timeout to ipcCall", async () => {
    ipcHandlers.set(METHOD, () => ({ verdict: VALID_VERDICT }));

    const input = {
      channelType: "telegram" as const,
      actorExternalId: "U_MEMBER",
    };
    await getInboundTrustVerdict(input);

    const call = ipcCallLog.find((c) => c.method === METHOD);
    expect(call?.params).toEqual(input);
    expect(call?.timeoutMs).toBe(2_000);
  });

  test("returns null when IPC transport fails (undefined)", async () => {
    ipcHandlers.set(METHOD, () => undefined);
    expect(
      await getInboundTrustVerdict({ channelType: "telegram" }),
    ).toBeNull();
  });

  test("returns null for a malformed verdict shape", async () => {
    ipcHandlers.set(METHOD, () => ({ verdict: { trustClass: "bogus" } }));
    expect(
      await getInboundTrustVerdict({ channelType: "telegram" }),
    ).toBeNull();
  });

  test("returns null when the verdict field is missing", async () => {
    ipcHandlers.set(METHOD, () => ({}));
    expect(
      await getInboundTrustVerdict({ channelType: "telegram" }),
    ).toBeNull();
  });

  test("returns null when the IPC call throws", async () => {
    ipcHandlers.set(METHOD, () => {
      throw new Error("socket exploded");
    });
    expect(
      await getInboundTrustVerdict({ channelType: "telegram" }),
    ).toBeNull();
  });
});
