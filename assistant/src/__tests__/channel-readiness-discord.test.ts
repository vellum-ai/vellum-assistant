import { beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

let mockSecureKeys: Record<string, string>;

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => mockSecureKeys[key] ?? null,
  setSecureKeyAsync: async (key: string, value: string) => {
    mockSecureKeys[key] = value;
    return true;
  },
  deleteSecureKeyAsync: async (key: string) => {
    delete mockSecureKeys[key];
    return true;
  },
}));

mock.module("../calls/twilio-rest.js", () => ({
  hasTwilioCredentials: () => false,
}));

mock.module("../calls/twilio-config.js", () => ({
  resolveTwilioPhoneNumber: () => undefined,
}));

mock.module("./channel-invite-transports/whatsapp.js", () => ({
  resolveWhatsAppDisplayNumber: () => undefined,
}));

type SocketHealth = {
  channel: string;
  status: "connected" | "disconnected" | "not_configured" | "unsupported";
  lastLivenessAt?: number;
};

/**
 * Every channel the socket-health reader was asked about, in order.
 *
 * The reader takes the channel as an argument and one function serves every
 * socket-backed channel, so a probe naming the wrong one reports a different
 * channel's connection as its own and no type notices.
 */
let askedChannels: string[];
let socketHealth: SocketHealth | Error;

mock.module("../channels/gateway-channel-socket-health.js", () => ({
  readChannelSocketHealth: async (channel: string) => {
    askedChannels.push(channel);
    if (socketHealth instanceof Error) {
      throw socketHealth;
    }
    return socketHealth;
  },
}));

beforeEach(() => {
  mockSecureKeys = {};
  askedChannels = [];
  socketHealth = { channel: "discord", status: "connected" };
  // The default install state: fail-closed and empty, admitting nothing until
  // someone lists channel ids. Tests that need admission say so.
});

async function runDiscordProbe() {
  const { createReadinessService } =
    await import("../runtime/channel-readiness-service.js");
  return createReadinessService().getReadiness("discord", false);
}

function findCheck(
  snapshot: Awaited<ReturnType<typeof runDiscordProbe>>[number],
  name: string,
) {
  return snapshot.localChecks.find((c) => c.name === name)!;
}

describe("discord readiness", () => {
  test("asks the gateway about Discord's own socket", async () => {
    await runDiscordProbe();

    expect(askedChannels).toEqual(["discord"]);
  });

  test("a fresh install has no token", async () => {
    const [snapshot] = await runDiscordProbe();

    expect(findCheck(snapshot, "bot_token").passed).toBe(false);
    // Nothing configured at all, which is a different report from a channel
    // half set up: no step has been taken rather than one left undone.
    expect(snapshot.setupStatus).toBe("not_configured");
  });

  test("Discord has one setup step, so it is never half configured", async () => {
    // A live socket without a token still reads as not configured rather than
    // incomplete. `incomplete` needs one configuration check passing while
    // another fails, and the token is now the only one: with the room
    // allow-list gone there is no second step to be part-way through.
    socketHealth = { channel: "discord", status: "connected" };

    const [snapshot] = await runDiscordProbe();

    expect(findCheck(snapshot, "bot_token").passed).toBe(false);
    expect(snapshot.setupStatus).toBe("not_configured");
  });

  test("a token and a live connection read as ready", async () => {
    mockSecureKeys[credentialKey("discord_channel", "bot_token")] = "bot-fake";
    socketHealth = {
      channel: "discord",
      status: "connected",
      lastLivenessAt: Date.parse("2026-08-21T17:00:00.000Z"),
    };

    const [snapshot] = await runDiscordProbe();

    expect(findCheck(snapshot, "bot_token").passed).toBe(true);
    const delivery = findCheck(snapshot, "inbound_delivery");
    expect(delivery.passed).toBe(true);
    expect(delivery.message).toContain("Discord");
    expect(delivery.message).toContain("2026-08-21T17:00:00.000Z");
    expect(snapshot.ready).toBe(true);
  });

  test("a dead socket reads as configured and failing, not unconfigured", async () => {
    mockSecureKeys[credentialKey("discord_channel", "bot_token")] = "bot-fake";
    socketHealth = { channel: "discord", status: "disconnected" };

    const [snapshot] = await runDiscordProbe();

    // The distinction the operational kind exists for: setup finished, and the
    // channel is down. Reporting it as unconfigured would send someone back
    // through a setup flow that has nothing left to do.
    expect(snapshot.setupStatus).toBe("ready");
    expect(snapshot.health).toBe("failing");
    expect(snapshot.ready).toBe(false);
    expect(findCheck(snapshot, "inbound_delivery").message).toMatch(
      /not reaching this assistant/i,
    );
  });

  test("an unreachable gateway is indeterminate, never a fault", async () => {
    mockSecureKeys[credentialKey("discord_channel", "bot_token")] = "bot-fake";
    socketHealth = new Error("gateway down");

    const [snapshot] = await runDiscordProbe();

    const delivery = findCheck(snapshot, "inbound_delivery");
    expect(delivery.passed).toBe(true);
    expect(delivery.indeterminate).toBe(true);
    // Not evidence of a fault, so it may not show the channel as broken, and
    // not evidence of delivery either, so it may not make it ready.
    expect(snapshot.health).not.toBe("failing");
  });

  test("Discord runs no remote checks, so nothing calls out to it", async () => {
    mockSecureKeys[credentialKey("discord_channel", "bot_token")] = "bot-fake";

    const { createReadinessService } =
      await import("../runtime/channel-readiness-service.js");
    const [snapshot] = await createReadinessService().getReadiness(
      "discord",
      true,
    );

    // One bot token serves both the gateway connection and the sends, so a
    // live socket already proves the credential a send would use.
    expect(snapshot.remoteChecks ?? []).toEqual([]);
  });
});
