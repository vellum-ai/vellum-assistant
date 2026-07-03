import { beforeEach, describe, expect, mock, test } from "bun:test";

// Gateway guardian-delivery list: null = couldn't determine (transport failure
// OR gateway-side resolver/DB error), [] = authoritative unbound, one active
// entry = bound.
let mockGuardianList: Array<Record<string, unknown>> | null = [];
const freshCalls: Array<{ channelTypes?: string[] } | undefined> = [];

mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  // Existence guard reads fresh (uncached); the binding/identity reads use the
  // cached variant. The service imports both, so both must be stubbed.
  getGuardianDeliveryFresh: (input?: { channelTypes?: string[] }) => {
    freshCalls.push(input);
    return Promise.resolve(mockGuardianList);
  },
  getGuardianDelivery: () => Promise.resolve(mockGuardianList),
  guardianForChannel: (
    list: Array<{ channelType: string; status: string }>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
  invalidateGuardianDeliveryCache: () => {},
}));

const { isGuardianBoundForChannel } =
  await import("../channel-verification-service.js");

describe("isGuardianBoundForChannel", () => {
  beforeEach(() => {
    mockGuardianList = [];
    freshCalls.length = 0;
  });

  test("reads fresh so a stale cached empty list can't mask a present guardian", async () => {
    await isGuardianBoundForChannel("telegram");
    expect(freshCalls).toEqual([{ channelTypes: ["telegram"] }]);
  });

  test("returns false when no guardian is bound", async () => {
    mockGuardianList = [];
    expect(await isGuardianBoundForChannel("telegram")).toBe(false);
  });

  test("returns true when a guardian is bound", async () => {
    mockGuardianList = [{ channelType: "telegram", status: "active" }];
    expect(await isGuardianBoundForChannel("telegram")).toBe(true);
  });

  test("null list (gateway unreachable) is treated as bound", async () => {
    mockGuardianList = null;
    expect(await isGuardianBoundForChannel("telegram")).toBe(true);
  });

  test("gateway resolver error (null, not []) is treated as bound — no duplicate", async () => {
    // A gateway-side DB/resolver error now reaches the reader as null (the
    // handler no longer swallows it into an empty list), so the guard's
    // null fail-safe applies and reports bound instead of mis-reading the
    // error as "no guardian" and allowing a duplicate binding.
    mockGuardianList = null;
    expect(await isGuardianBoundForChannel("telegram")).toBe(true);
  });

  test("genuine empty ([], not null) reports unbound so first-bind is allowed", async () => {
    mockGuardianList = [];
    expect(await isGuardianBoundForChannel("telegram")).toBe(false);
  });
});
