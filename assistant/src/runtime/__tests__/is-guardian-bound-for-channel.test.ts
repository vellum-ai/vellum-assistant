import { beforeEach, describe, expect, mock, test } from "bun:test";

// Gateway guardian-delivery list: null = unreachable, [] = unbound,
// one active entry = bound.
let mockGuardianList: Array<Record<string, unknown>> | null = [];
const freshCalls: Array<{ channelTypes?: string[] } | undefined> = [];

mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  // Existence guard must read fresh (uncached) — only this variant is stubbed.
  getGuardianDeliveryFresh: (input?: { channelTypes?: string[] }) => {
    freshCalls.push(input);
    return Promise.resolve(mockGuardianList);
  },
  guardianForChannel: (
    list: Array<{ channelType: string; status: string }>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
}));

const { isGuardianBoundForChannel } = await import(
  "../channel-verification-service.js"
);

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
});
