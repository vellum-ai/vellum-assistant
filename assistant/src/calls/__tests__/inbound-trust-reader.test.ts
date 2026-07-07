/**
 * Tests for the gateway-backed per-actor inbound trust reader.
 *
 * The combined read reports `{ ok: false }` on ANY failure (transport
 * failure, undefined, malformed shape, thrown error); the consumer decides
 * fail-open vs fail-closed. These tests pin that contract, the envelope's
 * admission-policy passthrough, and the forwarded method + params.
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

import {
  getInboundTrustVerdict,
  readInboundTrust,
  readPhoneCallerTrust,
} from "../inbound-trust-reader.js";

const METHOD = "resolve_inbound_trust";

const VALID_VERDICT = {
  trustClass: "trusted_contact",
  canonicalSenderId: "U_MEMBER",
  contactId: "c-member",
  status: "active",
} satisfies TrustVerdict;

beforeEach(() => {
  ipcHandlers.clear();
  ipcCallLog.length = 0;
});

describe("readInboundTrust", () => {
  test("returns the verdict and admission policy on a valid response", async () => {
    ipcHandlers.set(METHOD, () => ({
      verdict: VALID_VERDICT,
      admissionPolicy: "guardian_only",
    }));

    const result = await readInboundTrust({
      channelType: "telegram",
      actorExternalId: "U_MEMBER",
    });

    expect(result).toEqual({
      ok: true,
      verdict: VALID_VERDICT,
      admissionPolicy: "guardian_only",
    });
  });

  test("an explicit null admission policy is a successful read (admit, no enforcement)", async () => {
    ipcHandlers.set(METHOD, () => ({
      verdict: VALID_VERDICT,
      admissionPolicy: null,
    }));

    const result = await readInboundTrust({ channelType: "telegram" });

    expect(result).toEqual({
      ok: true,
      verdict: VALID_VERDICT,
      admissionPolicy: null,
    });
  });

  test("forwards the correct method, params, and timeout to ipcCall", async () => {
    ipcHandlers.set(METHOD, () => ({
      verdict: VALID_VERDICT,
      admissionPolicy: null,
    }));

    const input = {
      channelType: "telegram" as const,
      actorExternalId: "U_MEMBER",
    };
    await readInboundTrust(input);

    const call = ipcCallLog.find((c) => c.method === METHOD);
    expect(call?.params).toEqual(input);
    expect(call?.timeoutMs).toBe(2_000);
  });

  test("returns { ok: false } when IPC transport fails (undefined)", async () => {
    ipcHandlers.set(METHOD, () => undefined);
    expect(await readInboundTrust({ channelType: "telegram" })).toEqual({
      ok: false,
    });
  });

  test("returns { ok: false } for a malformed verdict shape", async () => {
    ipcHandlers.set(METHOD, () => ({
      verdict: { trustClass: "bogus" },
      admissionPolicy: null,
    }));
    expect(await readInboundTrust({ channelType: "telegram" })).toEqual({
      ok: false,
    });
  });

  test("returns { ok: false } when the admission policy field is missing", async () => {
    ipcHandlers.set(METHOD, () => ({ verdict: VALID_VERDICT }));
    expect(await readInboundTrust({ channelType: "telegram" })).toEqual({
      ok: false,
    });
  });

  test("returns { ok: false } for an out-of-vocabulary admission policy", async () => {
    ipcHandlers.set(METHOD, () => ({
      verdict: VALID_VERDICT,
      admissionPolicy: "everyone",
    }));
    expect(await readInboundTrust({ channelType: "telegram" })).toEqual({
      ok: false,
    });
  });

  test("returns { ok: false } when the verdict field is missing", async () => {
    ipcHandlers.set(METHOD, () => ({ admissionPolicy: null }));
    expect(await readInboundTrust({ channelType: "telegram" })).toEqual({
      ok: false,
    });
  });

  test("returns { ok: false } when the IPC call throws", async () => {
    ipcHandlers.set(METHOD, () => {
      throw new Error("socket exploded");
    });
    expect(await readInboundTrust({ channelType: "telegram" })).toEqual({
      ok: false,
    });
  });
});

describe("readPhoneCallerTrust", () => {
  test("reads the phone channel keyed by the caller number", async () => {
    ipcHandlers.set(METHOD, () => ({
      verdict: VALID_VERDICT,
      admissionPolicy: "trusted_contacts",
    }));

    const result = await readPhoneCallerTrust("+15555550100");

    expect(result).toEqual({
      ok: true,
      verdict: VALID_VERDICT,
      admissionPolicy: "trusted_contacts",
    });
    const call = ipcCallLog.find((c) => c.method === METHOD);
    expect(call?.params).toEqual({
      channelType: "phone",
      actorExternalId: "+15555550100",
    });
  });

  test("an empty caller number normalizes to an absent actorExternalId", async () => {
    ipcHandlers.set(METHOD, () => ({
      verdict: VALID_VERDICT,
      admissionPolicy: null,
    }));

    await readPhoneCallerTrust("");

    const call = ipcCallLog.find((c) => c.method === METHOD);
    expect(call?.params).toEqual({
      channelType: "phone",
      actorExternalId: undefined,
    });
  });
});

describe("getInboundTrustVerdict", () => {
  test("returns the gateway-resolved verdict on a valid response", async () => {
    ipcHandlers.set(METHOD, () => ({
      verdict: VALID_VERDICT,
      admissionPolicy: null,
    }));

    const verdict = await getInboundTrustVerdict({
      channelType: "telegram",
      actorExternalId: "U_MEMBER",
    });

    expect(verdict).toEqual(VALID_VERDICT);
  });

  test("returns null on any read failure", async () => {
    ipcHandlers.set(METHOD, () => undefined);
    expect(
      await getInboundTrustVerdict({ channelType: "telegram" }),
    ).toBeNull();
  });
});
