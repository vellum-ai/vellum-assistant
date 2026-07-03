/**
 * Tests for the gateway-backed guardian delivery reader.
 *
 * Guardian binding is near-static, so the reader caches behind a minutes-scale
 * TTL, clears event-driven on invalidation, and coalesces concurrent cold-cache
 * reads single-flight. These tests pin the parse contract plus all three cache
 * behaviors (TTL hit, invalidation, single-flight) and the failure-no-poison
 * rule.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianDelivery } from "@vellumai/gateway-client";

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
  __resetGuardianDeliveryCacheForTest,
  anyGuardian,
  getGuardianDelivery,
  getGuardianDeliveryFresh,
  guardianForChannel,
  invalidateGuardianDeliveryCache,
} from "../guardian-delivery-reader.js";

const METHOD = "resolve_guardian_delivery";

function countCalls(method: string): number {
  return ipcCallLog.filter((c) => c.method === method).length;
}

const telegramGuardian: GuardianDelivery = {
  channelType: "telegram",
  contactId: "contact-123",
  address: "@guardian",
  status: "active",
};

const emailGuardian: GuardianDelivery = {
  channelType: "email",
  contactId: "contact-456",
  address: "guardian@example.com",
  status: "active",
};

describe("getGuardianDelivery", () => {
  beforeEach(() => {
    __resetGuardianDeliveryCacheForTest();
    ipcHandlers.clear();
    ipcCallLog.length = 0;
  });

  test("returns the parsed guardian list", async () => {
    ipcHandlers.set(METHOD, () => ({ guardians: [telegramGuardian] }));

    expect(await getGuardianDelivery()).toEqual([telegramGuardian]);
  });

  test("bounds the IPC read with a short timeout", async () => {
    ipcHandlers.set(METHOD, () => ({ guardians: [] }));

    await getGuardianDelivery();

    const call = ipcCallLog.find((c) => c.method === METHOD);
    expect(call?.timeoutMs).toBe(2_000);
  });

  test("returns null when IPC transport fails (undefined)", async () => {
    ipcHandlers.set(METHOD, () => undefined);
    expect(await getGuardianDelivery()).toBeNull();
  });

  test("returns null when the IPC call throws", async () => {
    ipcHandlers.set(METHOD, () => {
      throw new Error("socket exploded");
    });
    expect(await getGuardianDelivery()).toBeNull();
  });

  test("returns null for a malformed response shape", async () => {
    ipcHandlers.set(METHOD, () => ({ guardians: "not-an-array" }));
    expect(await getGuardianDelivery()).toBeNull();
  });

  test("two calls within the TTL issue only ONE IPC call (cache hit)", async () => {
    ipcHandlers.set(METHOD, () => ({ guardians: [telegramGuardian] }));

    await getGuardianDelivery();
    await getGuardianDelivery();

    expect(countCalls(METHOD)).toBe(1);
  });

  test("caches per channelTypes filter key", async () => {
    ipcHandlers.set(METHOD, () => ({ guardians: [telegramGuardian] }));

    await getGuardianDelivery();
    await getGuardianDelivery({ channelTypes: ["telegram"] });

    // Distinct keys ("ALL" vs "telegram") miss each other → two IPC calls.
    expect(countCalls(METHOD)).toBe(2);
  });

  test("invalidateGuardianDeliveryCache() forces the next call to re-fetch", async () => {
    ipcHandlers.set(METHOD, () => ({ guardians: [telegramGuardian] }));

    await getGuardianDelivery();
    invalidateGuardianDeliveryCache();
    await getGuardianDelivery();

    expect(countCalls(METHOD)).toBe(2);
  });

  test("a burst of concurrent cold-cache calls issues only ONE IPC call (single-flight)", async () => {
    let resolveIpc: ((value: unknown) => void) | undefined;
    ipcHandlers.set(
      METHOD,
      () =>
        new Promise((resolve) => {
          resolveIpc = resolve;
        }),
    );

    const burst = Promise.all([
      getGuardianDelivery(),
      getGuardianDelivery(),
      getGuardianDelivery(),
    ]);
    resolveIpc?.({ guardians: [telegramGuardian] });
    const results = await burst;

    expect(countCalls(METHOD)).toBe(1);
    expect(results).toEqual([
      [telegramGuardian],
      [telegramGuardian],
      [telegramGuardian],
    ]);
  });

  test("an invalidation DURING an in-flight fetch is not masked — the next call re-fetches", async () => {
    let resolveIpc: ((value: unknown) => void) | undefined;
    ipcHandlers.set(
      METHOD,
      () =>
        new Promise((resolve) => {
          resolveIpc = resolve;
        }),
    );

    // Start a cold fetch, invalidate before it resolves, then resolve it.
    const inFlight = getGuardianDelivery();
    invalidateGuardianDeliveryCache();
    resolveIpc?.({ guardians: [telegramGuardian] });
    expect(await inFlight).toEqual([telegramGuardian]);

    // The pre-invalidation result must NOT have been cached: the next read
    // issues a fresh IPC rather than serving the now-stale value.
    ipcHandlers.set(METHOD, () => ({ guardians: [emailGuardian] }));
    expect(await getGuardianDelivery()).toEqual([emailGuardian]);
    expect(countCalls(METHOD)).toBe(2);
  });

  test("a failure does NOT poison the cache — the next call retries", async () => {
    ipcHandlers.set(METHOD, () => undefined);
    expect(await getGuardianDelivery()).toBeNull();

    ipcHandlers.set(METHOD, () => ({ guardians: [telegramGuardian] }));
    expect(await getGuardianDelivery()).toEqual([telegramGuardian]);
    expect(countCalls(METHOD)).toBe(2);
  });

  test("fresh read ignores a stale cached entry and re-fetches", async () => {
    // Seed the cache with an empty list (the stale gateway-side view).
    ipcHandlers.set(METHOD, () => ({ guardians: [] }));
    expect(await getGuardianDelivery()).toEqual([]);

    // A cached read still serves the stale empty list (no new IPC)...
    expect(await getGuardianDelivery()).toEqual([]);
    expect(countCalls(METHOD)).toBe(1);

    // ...but a fresh read bypasses the cache and sees the now-present guardian.
    ipcHandlers.set(METHOD, () => ({ guardians: [telegramGuardian] }));
    expect(await getGuardianDeliveryFresh()).toEqual([telegramGuardian]);
    expect(countCalls(METHOD)).toBe(2);
  });

  test("fresh read updates the cache with the fresh result", async () => {
    ipcHandlers.set(METHOD, () => ({ guardians: [] }));
    await getGuardianDelivery();

    ipcHandlers.set(METHOD, () => ({ guardians: [telegramGuardian] }));
    await getGuardianDeliveryFresh();

    // A subsequent cached read serves the refreshed value without a new IPC.
    expect(await getGuardianDelivery()).toEqual([telegramGuardian]);
    expect(countCalls(METHOD)).toBe(2);
  });

  test("getGuardianDeliveryFresh bypasses a stale cached empty list", async () => {
    ipcHandlers.set(METHOD, () => ({ guardians: [] }));
    expect(await getGuardianDelivery({ channelTypes: ["telegram"] })).toEqual(
      [],
    );

    ipcHandlers.set(METHOD, () => ({ guardians: [telegramGuardian] }));
    expect(
      await getGuardianDeliveryFresh({ channelTypes: ["telegram"] }),
    ).toEqual([telegramGuardian]);
    expect(countCalls(METHOD)).toBe(2);
  });

  test("a burst of forceRefresh reads still coalesces single-flight", async () => {
    let resolveIpc: ((value: unknown) => void) | undefined;
    ipcHandlers.set(
      METHOD,
      () =>
        new Promise((resolve) => {
          resolveIpc = resolve;
        }),
    );

    const burst = Promise.all([
      getGuardianDeliveryFresh(),
      getGuardianDeliveryFresh(),
      getGuardianDeliveryFresh(),
    ]);
    resolveIpc?.({ guardians: [telegramGuardian] });
    await burst;

    expect(countCalls(METHOD)).toBe(1);
  });

  test("a fresh read does NOT coalesce with an in-flight non-force fetch (issues its own IPC)", async () => {
    // A normal read starts a fetch that will resolve to the pre-write empty
    // list and is still in flight when the fresh read arrives.
    let resolveStale: ((value: unknown) => void) | undefined;
    ipcHandlers.set(
      METHOD,
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    );
    const stale = getGuardianDelivery();

    // The gateway-side write lands (not reflected in the in-flight fetch). The
    // fresh read must NOT reuse the stale in-flight promise — it issues its own
    // IPC observing the post-write guardian.
    ipcHandlers.set(METHOD, () => ({ guardians: [telegramGuardian] }));
    const fresh = await getGuardianDeliveryFresh();
    expect(fresh).toEqual([telegramGuardian]);

    // Release the stale fetch last; it must not have masked the fresh result.
    resolveStale?.({ guardians: [] });
    expect(await stale).toEqual([]);
    expect(countCalls(METHOD)).toBe(2);
  });
});

describe("selectors", () => {
  test("guardianForChannel picks the first active match for the type", () => {
    const inactive: GuardianDelivery = {
      ...telegramGuardian,
      contactId: "contact-999",
      status: "revoked",
    };
    const list = [inactive, telegramGuardian, emailGuardian];

    expect(guardianForChannel(list, "telegram")).toBe(telegramGuardian);
    expect(guardianForChannel(list, "email")).toBe(emailGuardian);
    expect(guardianForChannel(list, "phone")).toBeUndefined();
  });

  test("anyGuardian returns the first overall", () => {
    expect(anyGuardian([emailGuardian, telegramGuardian])).toBe(emailGuardian);
    expect(anyGuardian([])).toBeUndefined();
  });
});
