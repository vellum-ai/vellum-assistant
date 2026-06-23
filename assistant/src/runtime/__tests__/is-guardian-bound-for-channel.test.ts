import { beforeEach, describe, expect, mock, test } from "bun:test";

// Gateway guardian-delivery list: null = unreachable, [] = unbound,
// one active entry = bound.
let mockGuardianList: Array<Record<string, unknown>> | null = [];

mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: () => Promise.resolve(mockGuardianList),
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
