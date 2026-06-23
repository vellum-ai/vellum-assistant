/**
 * Tests for getConnectedChannels connectivity resolution.
 *
 * Connectivity must mirror destination-resolver's `resolveGuardian`:
 * gateway-first, with a LOCAL contacts fallback only when the gateway list is
 * null (unreachable). This keeps a channel from being marked connected when it
 * can't be delivered (and vice-versa).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianDelivery } from "@vellumai/gateway-client";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
  truncateForLog: (value: string) => value,
}));

let deliverableChannels: string[] = [];
let gatewayGuardians: GuardianDelivery[] | null = null;
let localChatId: string | null = null;

const realConfig = await import("../../channels/config.js");

mock.module("../../channels/config.js", () => ({
  ...realConfig,
  getDeliverableChannels: () => deliverableChannels,
}));

const realReader = await import("../../contacts/guardian-delivery-reader.js");

mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  ...realReader,
  getGuardianDelivery: async () => gatewayGuardians,
}));

const realContactStore = await import("../../contacts/contact-store.js");

mock.module("../../contacts/contact-store.js", () => ({
  ...realContactStore,
  findGuardianForChannel: (_channelType: string) =>
    localChatId === null
      ? null
      : { contact: { principalId: "p1" }, channel: { externalChatId: localChatId } },
}));

const { getConnectedChannels } = await import("../emit-signal.js");

function gatewayBinding(channelType: string, externalChatId: string): GuardianDelivery {
  return { channelType, contactId: "c1", address: "addr", externalChatId, status: "active" };
}

beforeEach(() => {
  deliverableChannels = [];
  gatewayGuardians = null;
  localChatId = null;
});

describe("getConnectedChannels gateway-first-then-local connectivity", () => {
  test("marks telegram connected from a gateway-only binding", async () => {
    deliverableChannels = ["telegram"];
    gatewayGuardians = [gatewayBinding("telegram", "123")];
    localChatId = null;

    expect(await getConnectedChannels()).toContain("telegram");
  });

  test("falls back to a local binding when the gateway is unreachable (null)", async () => {
    deliverableChannels = ["telegram"];
    gatewayGuardians = null;
    localChatId = "456";

    expect(await getConnectedChannels()).toContain("telegram");
  });

  test("marks telegram disconnected when neither source has a binding", async () => {
    deliverableChannels = ["telegram"];
    gatewayGuardians = null;
    localChatId = null;

    expect(await getConnectedChannels()).not.toContain("telegram");
  });

  test("does not fall back to local when the gateway responds without that channel", async () => {
    // Gateway present but empty for telegram ⇒ gateway is authoritative, no
    // per-channel local fallback (mirrors destination-resolver).
    deliverableChannels = ["telegram"];
    gatewayGuardians = [];
    localChatId = "789";

    expect(await getConnectedChannels()).not.toContain("telegram");
  });

  test("only marks slack connected for D-prefixed (DM) chat IDs", async () => {
    deliverableChannels = ["slack"];
    gatewayGuardians = [gatewayBinding("slack", "C-public")];
    expect(await getConnectedChannels()).not.toContain("slack");

    gatewayGuardians = [gatewayBinding("slack", "D-dm")];
    expect(await getConnectedChannels()).toContain("slack");
  });

  test("always reports vellum and platform connected", async () => {
    deliverableChannels = ["vellum", "platform"];
    gatewayGuardians = null;

    const connected = await getConnectedChannels();
    expect(connected).toContain("vellum");
    expect(connected).toContain("platform");
  });
});
