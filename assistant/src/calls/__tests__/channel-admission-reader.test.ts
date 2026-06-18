/**
 * Tests for the gateway-backed channel admission policy reader.
 *
 * The reader fails open (returns null = admit) so a gateway IPC failure can
 * never block a live call. These tests pin that contract plus the TTL cache.
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

import {
  _clearCacheForTesting,
  getChannelAdmissionPolicy,
} from "../channel-admission-reader.js";

const METHOD = "get_channel_admission_policy";

function countCalls(method: string): number {
  return ipcCallLog.filter((c) => c.method === method).length;
}

describe("getChannelAdmissionPolicy", () => {
  beforeEach(() => {
    _clearCacheForTesting();
    ipcHandlers.clear();
    ipcCallLog.length = 0;
  });

  test("returns the gateway-resolved policy and caches it within the TTL", async () => {
    ipcHandlers.set(METHOD, () => ({ policy: "guardian_only" }));

    expect(await getChannelAdmissionPolicy("telegram")).toBe("guardian_only");
    // Second call within TTL is served from cache — no extra IPC round-trip.
    expect(await getChannelAdmissionPolicy("telegram")).toBe("guardian_only");
    expect(countCalls(METHOD)).toBe(1);
  });

  test("bounds the IPC read with a short timeout so it fails open promptly", async () => {
    ipcHandlers.set(METHOD, () => ({ policy: "guardian_only" }));

    await getChannelAdmissionPolicy("telegram");

    const call = ipcCallLog.find((c) => c.method === METHOD);
    expect(call?.timeoutMs).toBe(1_000);
  });

  test("returns null when IPC transport fails (undefined)", async () => {
    ipcHandlers.set(METHOD, () => undefined);
    expect(await getChannelAdmissionPolicy("telegram")).toBeNull();
  });

  test("returns null when the gateway explicitly resolves no policy", async () => {
    ipcHandlers.set(METHOD, () => ({ policy: null }));
    expect(await getChannelAdmissionPolicy("telegram")).toBeNull();
  });

  test("returns null when the IPC call throws", async () => {
    ipcHandlers.set(METHOD, () => {
      throw new Error("socket exploded");
    });
    expect(await getChannelAdmissionPolicy("telegram")).toBeNull();
  });

  test("returns null for an invalid policy string", async () => {
    ipcHandlers.set(METHOD, () => ({ policy: "definitely-not-a-policy" }));
    expect(await getChannelAdmissionPolicy("telegram")).toBeNull();
  });

  test("caches the explicit no-enforcement (null) answer within the TTL", async () => {
    // The gateway successfully said "no enforcement" — a real, cacheable answer.
    ipcHandlers.set(METHOD, () => ({ policy: null }));
    expect(await getChannelAdmissionPolicy("telegram")).toBeNull();
    expect(await getChannelAdmissionPolicy("telegram")).toBeNull();
    expect(countCalls(METHOD)).toBe(1);
  });

  test("does NOT cache a transport failure (undefined) — re-consults the gateway", async () => {
    // First setup: gateway hiccup → fail open to null, NOT cached.
    ipcHandlers.set(METHOD, () => undefined);
    expect(await getChannelAdmissionPolicy("telegram")).toBeNull();

    // Gateway recovers with a restrictive policy: the next setup must re-attempt
    // the IPC (not serve a stale fail-open null) and honor the now-recovered floor.
    ipcHandlers.set(METHOD, () => ({ policy: "guardian_only" }));
    expect(await getChannelAdmissionPolicy("telegram")).toBe("guardian_only");
    expect(countCalls(METHOD)).toBe(2);
  });

  test("does NOT cache a thrown IPC error — re-consults the gateway", async () => {
    ipcHandlers.set(METHOD, () => {
      throw new Error("socket exploded");
    });
    expect(await getChannelAdmissionPolicy("telegram")).toBeNull();

    ipcHandlers.set(METHOD, () => ({ policy: "no_one" }));
    expect(await getChannelAdmissionPolicy("telegram")).toBe("no_one");
    expect(countCalls(METHOD)).toBe(2);
  });

  test("does NOT cache a malformed shape — re-consults the gateway", async () => {
    ipcHandlers.set(METHOD, () => ({ policy: "definitely-not-a-policy" }));
    expect(await getChannelAdmissionPolicy("telegram")).toBeNull();

    ipcHandlers.set(METHOD, () => ({ policy: "guardian_only" }));
    expect(await getChannelAdmissionPolicy("telegram")).toBe("guardian_only");
    expect(countCalls(METHOD)).toBe(2);
  });
});
