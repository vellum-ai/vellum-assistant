/**
 * Tests for the plugin-facing contact lookup.
 *
 * The store and the gateway reader are mocked at module level so these stay
 * about the contract a gating caller depends on: what `null` means, and what an
 * unreachable gateway looks like.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type ChannelState = { status: string; verifiedAt: number | null } | undefined;

let storeResult: unknown = null;
let gatewayResult: ChannelState;
let lastStoreQuery: unknown = null;

mock.module("../../contacts/contact-store.js", () => ({
  findContactChannel: mock((params: unknown) => {
    lastStoreQuery = params;
    return storeResult;
  }),
}));

mock.module("../../contacts/gateway-channel-read.js", () => ({
  gatewayContactChannelState: mock(async () => gatewayResult),
}));

const { findContactByChannelAddress } = await import("../contacts.js");

function match(overrides: Record<string, unknown> = {}) {
  return {
    contact: { id: "contact_1", displayName: "Dana" },
    channel: {
      contactId: "contact_1",
      type: "phone",
      address: "+15551234567",
    },
    ...overrides,
  };
}

beforeEach(() => {
  storeResult = null;
  gatewayResult = undefined;
  lastStoreQuery = null;
});

describe("findContactByChannelAddress", () => {
  test("returns null when no contact holds the address", async () => {
    // The load-bearing case for a gate: null is "not a known contact", never
    // "unknown, allow".
    expect(
      await findContactByChannelAddress("phone", "+15559990000"),
    ).toBeNull();
  });

  test("passes the channel type and address through to the store", async () => {
    await findContactByChannelAddress("phone", "+15551234567");
    expect(lastStoreQuery).toEqual({
      channelType: "phone",
      address: "+15551234567",
    });
  });

  test("returns the contact with its gateway status", async () => {
    storeResult = match();
    gatewayResult = { status: "active", verifiedAt: 1_700_000_000_000 };

    const result = await findContactByChannelAddress("phone", "+15551234567");

    expect(result).toEqual({
      contactId: "contact_1",
      displayName: "Dana",
      channelType: "phone",
      address: "+15551234567",
      status: "active",
      verifiedAt: 1_700_000_000_000,
    });
  });

  test("reports the stored address, which may be canonicalized", async () => {
    // The store canonicalizes on lookup, so a caller that keys on the address
    // should key on what came back rather than what it asked for.
    storeResult = match();

    const result = await findContactByChannelAddress("phone", "5551234567");

    expect(result?.address).toBe("+15551234567");
  });

  test("an unreachable gateway leaves status undefined rather than defaulting", async () => {
    // The reader this wraps fails open for display callers. Defaulting to
    // "active" here would silently turn every gate built on it into a hole.
    storeResult = match();
    gatewayResult = undefined;

    const result = await findContactByChannelAddress("phone", "+15551234567");

    expect(result).not.toBeNull();
    expect(result?.status).toBeUndefined();
    expect(result?.verifiedAt).toBeUndefined();
  });

  test("surfaces a non-active status verbatim", async () => {
    storeResult = match();
    gatewayResult = { status: "blocked", verifiedAt: null };

    const result = await findContactByChannelAddress("phone", "+15551234567");

    expect(result?.status).toBe("blocked");
  });
});
