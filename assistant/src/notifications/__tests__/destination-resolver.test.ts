/**
 * Verifies resolveDestinations resolves guardian delivery endpoints from the
 * gateway-provided guardian list, with shapes identical to the local read, and
 * falls back to the local contacts read when the list is null.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianDelivery } from "@vellumai/gateway-client";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Local fallback read; mocked so the null-list path is deterministic.
let localGuardian:
  | { contact: { principalId?: string }; channel: { address: string; externalChatId?: string } }
  | null = null;

mock.module("../../contacts/contact-store.js", () => ({
  findGuardianForChannel: (_channelType: string) => localGuardian,
}));

const { resolveDestinations } = await import("../destination-resolver.js");

function guardian(
  overrides: Partial<GuardianDelivery> & Pick<GuardianDelivery, "channelType" | "address">,
): GuardianDelivery {
  return {
    contactId: "contact-1",
    status: "active",
    ...overrides,
  } as GuardianDelivery;
}

describe("resolveDestinations — gateway guardian list", () => {
  beforeEach(() => {
    localGuardian = null;
  });

  test("vellum carries guardianPrincipalId from the gateway list", () => {
    const list = [
      guardian({ channelType: "vellum", address: "user@example.com", principalId: "prin-1" }),
    ];
    const result = resolveDestinations(["vellum"], list);
    expect(result.get("vellum")).toEqual({
      channel: "vellum",
      metadata: { guardianPrincipalId: "prin-1" },
    });
  });

  test("platform carries guardianPrincipalId from the vellum guardian", () => {
    const list = [
      guardian({ channelType: "vellum", address: "user@example.com", principalId: "prin-1" }),
    ];
    const result = resolveDestinations(["platform"], list);
    expect(result.get("platform")).toEqual({
      channel: "platform",
      metadata: { guardianPrincipalId: "prin-1" },
    });
  });

  test("telegram resolves endpoint and binding context", () => {
    const list = [
      guardian({
        channelType: "telegram",
        address: "tg-user",
        externalChatId: "12345",
      }),
    ];
    const result = resolveDestinations(["telegram"], list);
    expect(result.get("telegram")).toEqual({
      channel: "telegram",
      endpoint: "12345",
      metadata: { externalUserId: "tg-user" },
      bindingContext: {
        sourceChannel: "telegram",
        externalChatId: "12345",
        externalUserId: "tg-user",
      },
    });
  });

  test("telegram without externalChatId is omitted", () => {
    const list = [guardian({ channelType: "telegram", address: "tg-user" })];
    const result = resolveDestinations(["telegram"], list);
    expect(result.has("telegram")).toBe(false);
  });

  test("slack resolves DM endpoint and binding context", () => {
    const list = [
      guardian({
        channelType: "slack",
        address: "slack-user",
        externalChatId: "D123",
      }),
    ];
    const result = resolveDestinations(["slack"], list);
    expect(result.get("slack")).toEqual({
      channel: "slack",
      endpoint: "D123",
      metadata: { externalUserId: "slack-user" },
      bindingContext: {
        sourceChannel: "slack",
        externalChatId: "D123",
        externalUserId: "slack-user",
      },
    });
  });

  test("slack non-DM channel is dropped", () => {
    const list = [
      guardian({
        channelType: "slack",
        address: "slack-user",
        externalChatId: "C123",
      }),
    ];
    const result = resolveDestinations(["slack"], list);
    expect(result.has("slack")).toBe(false);
  });

  test("inactive guardian is ignored", () => {
    const list = [
      guardian({
        channelType: "telegram",
        address: "tg-user",
        externalChatId: "12345",
        status: "revoked",
      }),
    ];
    const result = resolveDestinations(["telegram"], list);
    expect(result.has("telegram")).toBe(false);
  });
});

describe("resolveDestinations — null list falls back to local read", () => {
  beforeEach(() => {
    localGuardian = null;
  });

  test("telegram resolves from the local contacts read", () => {
    localGuardian = {
      contact: {},
      channel: { address: "tg-user", externalChatId: "12345" },
    };
    const result = resolveDestinations(["telegram"], null);
    expect(result.get("telegram")).toEqual({
      channel: "telegram",
      endpoint: "12345",
      metadata: { externalUserId: "tg-user" },
      bindingContext: {
        sourceChannel: "telegram",
        externalChatId: "12345",
        externalUserId: "tg-user",
      },
    });
  });

  test("slack DM resolves from the local contacts read", () => {
    localGuardian = {
      contact: {},
      channel: { address: "slack-user", externalChatId: "D123" },
    };
    const result = resolveDestinations(["slack"], null);
    expect(result.get("slack")).toEqual({
      channel: "slack",
      endpoint: "D123",
      metadata: { externalUserId: "slack-user" },
      bindingContext: {
        sourceChannel: "slack",
        externalChatId: "D123",
        externalUserId: "slack-user",
      },
    });
  });

  test("vellum carries principalId from the local contacts read", () => {
    localGuardian = {
      contact: { principalId: "prin-1" },
      channel: { address: "user@example.com" },
    };
    const result = resolveDestinations(["vellum"], null);
    expect(result.get("vellum")).toEqual({
      channel: "vellum",
      metadata: { guardianPrincipalId: "prin-1" },
    });
  });
});

describe("resolveDestinations — gateway yields no channel match falls back to local", () => {
  beforeEach(() => {
    localGuardian = null;
  });

  test("empty gateway list falls back to local telegram binding", () => {
    localGuardian = {
      contact: {},
      channel: { address: "tg-user", externalChatId: "12345" },
    };
    const result = resolveDestinations(["telegram"], []);
    expect(result.get("telegram")).toEqual({
      channel: "telegram",
      endpoint: "12345",
      metadata: { externalUserId: "tg-user" },
      bindingContext: {
        sourceChannel: "telegram",
        externalChatId: "12345",
        externalUserId: "tg-user",
      },
    });
  });

  test("gateway list missing the channel falls back to local slack DM", () => {
    localGuardian = {
      contact: {},
      channel: { address: "slack-user", externalChatId: "D123" },
    };
    // Gateway returns a telegram guardian but no slack entry.
    const list = [
      guardian({ channelType: "telegram", address: "tg", externalChatId: "999" }),
    ];
    const result = resolveDestinations(["slack"], list);
    expect(result.get("slack")).toEqual({
      channel: "slack",
      endpoint: "D123",
      metadata: { externalUserId: "slack-user" },
      bindingContext: {
        sourceChannel: "slack",
        externalChatId: "D123",
        externalUserId: "slack-user",
      },
    });
  });

  test("empty gateway list falls back to local vellum principalId", () => {
    localGuardian = {
      contact: { principalId: "prin-1" },
      channel: { address: "user@example.com" },
    };
    const result = resolveDestinations(["vellum"], []);
    expect(result.get("vellum")).toEqual({
      channel: "vellum",
      metadata: { guardianPrincipalId: "prin-1" },
    });
  });

  test("empty gateway list with no local binding omits telegram", () => {
    localGuardian = null;
    const result = resolveDestinations(["telegram"], []);
    expect(result.has("telegram")).toBe(false);
  });
});
