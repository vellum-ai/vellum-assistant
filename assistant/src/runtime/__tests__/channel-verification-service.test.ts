import { beforeEach, describe, expect, mock, test } from "bun:test";

// Gateway guardian-delivery list drives both getGuardianBinding and isGuardian:
// null = couldn't determine, [] = authoritative unbound, one active entry =
// bound. Tests set this to mirror the gateway-owned ACL state.
let mockGuardianList: Array<Record<string, unknown>> | null = [];
const cachedCalls: Array<{ channelTypes?: string[] } | undefined> = [];

const resolveList = (input?: { channelTypes?: string[] }) => {
  cachedCalls.push(input);
  return Promise.resolve(mockGuardianList);
};

mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: resolveList,
  getGuardianDeliveryFresh: resolveList,
  guardianForChannel: (
    list: Array<{ channelType: string; status: string }>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
  invalidateGuardianDeliveryCache: () => {},
}));

const { getGuardianBinding, isGuardian } =
  await import("../channel-verification-service.js");

const TELEGRAM_DELIVERY = {
  channelType: "telegram",
  contactId: "contact-1",
  principalId: "principal-1",
  displayName: "Guardian",
  address: "guardian-handle",
  externalChatId: "chat-1",
  status: "active",
  verifiedAt: 1700,
};

describe("getGuardianBinding", () => {
  beforeEach(() => {
    mockGuardianList = [];
    cachedCalls.length = 0;
  });

  test("filters delivery by the requested channel type", async () => {
    await getGuardianBinding("asst-1", "telegram");
    expect(cachedCalls).toEqual([{ channelTypes: ["telegram"] }]);
  });

  test("returns null when no guardian is bound", async () => {
    mockGuardianList = [];
    expect(await getGuardianBinding("asst-1", "telegram")).toBeNull();
  });

  test("returns null when the gateway is unreachable", async () => {
    mockGuardianList = null;
    expect(await getGuardianBinding("asst-1", "telegram")).toBeNull();
  });

  test("synthesizes the binding from the gateway delivery", async () => {
    mockGuardianList = [TELEGRAM_DELIVERY];

    const binding = await getGuardianBinding("asst-1", "telegram");

    expect(binding).not.toBeNull();
    expect(binding?.assistantId).toBe("asst-1");
    expect(binding?.channel).toBe("telegram");
    expect(binding?.id).toBe("contact-1");
    expect(binding?.guardianPrincipalId).toBe("principal-1");
    expect(binding?.guardianExternalUserId).toBe("guardian-handle");
    expect(binding?.guardianDeliveryChatId).toBe("chat-1");
    expect(binding?.verifiedAt).toBe(1700);
    expect(binding?.status).toBe("active");
    expect(binding?.verifiedVia).toBe("verified");
  });

  test("a missing principal surfaces as null (unresolved), never an empty string", async () => {
    mockGuardianList = [
      {
        channelType: "telegram",
        contactId: "contact-2",
        address: "addr",
        status: "active",
      },
    ];

    const binding = await getGuardianBinding("asst-1", "telegram");

    expect(binding?.guardianPrincipalId).toBeNull();
    expect(binding?.guardianDeliveryChatId).toBe("");
    expect(binding?.verifiedAt).toBe(0);
  });

  test("ignores deliveries for a different channel", async () => {
    mockGuardianList = [TELEGRAM_DELIVERY];
    expect(await getGuardianBinding("asst-1", "phone")).toBeNull();
  });
});

describe("isGuardian", () => {
  beforeEach(() => {
    mockGuardianList = [];
    cachedCalls.length = 0;
  });

  test("returns true when the address matches the gateway guardian", async () => {
    mockGuardianList = [TELEGRAM_DELIVERY];
    expect(await isGuardian("asst-1", "telegram", "guardian-handle")).toBe(
      true,
    );
  });

  test("compares case-insensitively", async () => {
    mockGuardianList = [TELEGRAM_DELIVERY];
    expect(await isGuardian("asst-1", "telegram", "GUARDIAN-HANDLE")).toBe(
      true,
    );
  });

  test("returns false for a non-matching address", async () => {
    mockGuardianList = [TELEGRAM_DELIVERY];
    expect(await isGuardian("asst-1", "telegram", "someone-else")).toBe(false);
  });

  test("returns false when no guardian is bound", async () => {
    mockGuardianList = [];
    expect(await isGuardian("asst-1", "telegram", "guardian-handle")).toBe(
      false,
    );
  });

  test("returns false when the gateway is unreachable", async () => {
    mockGuardianList = null;
    expect(await isGuardian("asst-1", "telegram", "guardian-handle")).toBe(
      false,
    );
  });
});
