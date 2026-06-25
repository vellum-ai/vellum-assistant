/**
 * Tests for getConnectedChannels connectivity resolution.
 *
 * Connectivity mirrors destination-resolver's `resolveGuardian`: guardian
 * delivery is sourced solely from the gateway. A channel with no active gateway
 * binding is not connected, keeping connectivity aligned with deliverability.
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

const { getConnectedChannels } = await import("../emit-signal.js");

function gatewayBinding(channelType: string, externalChatId: string): GuardianDelivery {
  return { channelType, contactId: "c1", address: "addr", externalChatId, status: "active" };
}

beforeEach(() => {
  deliverableChannels = [];
  gatewayGuardians = null;
});

describe("getConnectedChannels gateway connectivity", () => {
  test("marks telegram connected from a gateway binding", async () => {
    deliverableChannels = ["telegram"];
    gatewayGuardians = [gatewayBinding("telegram", "123")];

    expect(await getConnectedChannels()).toContain("telegram");
  });

  test("marks telegram disconnected when the gateway is unreachable (null)", async () => {
    deliverableChannels = ["telegram"];
    gatewayGuardians = null;

    expect(await getConnectedChannels()).not.toContain("telegram");
  });

  test("marks telegram disconnected when the gateway has no binding", async () => {
    deliverableChannels = ["telegram"];
    gatewayGuardians = [];

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
