/**
 * Tests for the gateway-backed per-actor inbound trust reader.
 *
 * The combined read reports `{ ok: false }` on ANY failure (transport
 * failure, undefined, malformed shape, thrown error); the consumer decides
 * fail-open vs fail-closed. These tests pin that contract, the envelope's
 * admission-policy passthrough, the pre-envelope-gateway fallback (absent
 * `admissionPolicy` key → standalone policy read, fail-closed composition),
 * and the forwarded method + params.
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

import { _clearCacheForTesting } from "../channel-admission-reader.js";
import {
  readInboundTrust,
  readPhoneCallerTrust,
} from "../inbound-trust-reader.js";

const METHOD = "resolve_inbound_trust";
const FALLBACK_METHOD = "get_channel_admission_policy";

const VALID_VERDICT = {
  trustClass: "trusted_contact",
  canonicalSenderId: "U_MEMBER",
  contactId: "c-member",
  status: "active",
} satisfies TrustVerdict;

beforeEach(() => {
  ipcHandlers.clear();
  ipcCallLog.length = 0;
  _clearCacheForTesting();
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

  test("an explicit null admission policy is a successful read (admit, no enforcement) — no fallback read", async () => {
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
    expect(
      ipcCallLog.some((c) => c.method === FALLBACK_METHOD),
    ).toBe(false);
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

  test("absent admission policy key (pre-envelope gateway) keeps the verdict and reads the policy via the fallback", async () => {
    ipcHandlers.set(METHOD, () => ({ verdict: VALID_VERDICT }));
    ipcHandlers.set(FALLBACK_METHOD, () => ({ policy: "trusted_contacts" }));

    const result = await readInboundTrust({ channelType: "telegram" });

    expect(result).toEqual({
      ok: true,
      verdict: VALID_VERDICT,
      admissionPolicy: "trusted_contacts",
    });
    const fallbackCall = ipcCallLog.find((c) => c.method === FALLBACK_METHOD);
    expect(fallbackCall?.params).toEqual({ channelType: "telegram" });
  });

  test("absent admission policy key with an explicit-null fallback answer admits with no enforcement", async () => {
    ipcHandlers.set(METHOD, () => ({ verdict: VALID_VERDICT }));
    ipcHandlers.set(FALLBACK_METHOD, () => ({ policy: null }));

    expect(await readInboundTrust({ channelType: "telegram" })).toEqual({
      ok: true,
      verdict: VALID_VERDICT,
      admissionPolicy: null,
    });
  });

  test("absent admission policy key + failed fallback read composes fail-closed ({ ok: false })", async () => {
    ipcHandlers.set(METHOD, () => ({ verdict: VALID_VERDICT }));
    ipcHandlers.set(FALLBACK_METHOD, () => undefined);

    expect(await readInboundTrust({ channelType: "telegram" })).toEqual({
      ok: false,
    });
    expect(ipcCallLog.some((c) => c.method === FALLBACK_METHOD)).toBe(true);
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

