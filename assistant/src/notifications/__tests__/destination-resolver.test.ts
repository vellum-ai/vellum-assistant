/**
 * Verifies resolveDestinations resolves guardian delivery endpoints from the
 * gateway-provided guardian list, and omits a channel when the list is
 * null/empty or carries no entry for it.
 */

import { describe, expect, test } from "bun:test";

import type { GuardianDelivery } from "@vellumai/gateway-client";

const { resolveDestinations } = await import("../destination-resolver.js");

function guardian(
  overrides: Partial<GuardianDelivery> &
    Pick<GuardianDelivery, "channelType" | "address">,
): GuardianDelivery {
  return {
    contactId: "contact-1",
    status: "active",
    ...overrides,
  } as GuardianDelivery;
}

describe("resolveDestinations — gateway guardian list", () => {
  test("vellum carries guardianPrincipalId from the gateway list", () => {
    const list = [
      guardian({
        channelType: "vellum",
        address: "user@example.com",
        principalId: "prin-1",
      }),
    ];
    const result = resolveDestinations(["vellum"], list);
    expect(result.get("vellum")).toEqual({
      channel: "vellum",
      metadata: { guardianPrincipalId: "prin-1" },
    });
  });

  test("platform carries guardianPrincipalId from the vellum guardian", () => {
    const list = [
      guardian({
        channelType: "vellum",
        address: "user@example.com",
        principalId: "prin-1",
      }),
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

describe("resolveDestinations — gateway empty or missing channel", () => {
  test("null gateway list omits telegram", () => {
    const result = resolveDestinations(["telegram"], null);
    expect(result.has("telegram")).toBe(false);
  });

  test("null gateway list omits vellum principalId metadata", () => {
    const result = resolveDestinations(["vellum"], null);
    expect(result.get("vellum")).toEqual({ channel: "vellum" });
  });

  test("empty gateway list omits telegram", () => {
    const result = resolveDestinations(["telegram"], []);
    expect(result.has("telegram")).toBe(false);
  });

  test("gateway list missing the channel omits slack", () => {
    // Gateway returns a telegram guardian but no slack entry.
    const list = [
      guardian({
        channelType: "telegram",
        address: "tg",
        externalChatId: "999",
      }),
    ];
    const result = resolveDestinations(["slack"], list);
    expect(result.has("slack")).toBe(false);
  });
});
