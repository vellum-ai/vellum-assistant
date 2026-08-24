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

/** How many channels the gateway reports on Discord's allow-list. */
let admittedChannelCount: number | Error;

mock.module("../channels/gateway-discord-admission.js", () => ({
  readDiscordAdmission: async () => {
    if (admittedChannelCount instanceof Error) {
      throw admittedChannelCount;
    }
    return { admittedChannelCount };
  },
}));

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
  admittedChannelCount = 0;
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

  test("a fresh install has neither a token nor an allow-list", async () => {
    const [snapshot] = await runDiscordProbe();

    expect(findCheck(snapshot, "bot_token").passed).toBe(false);
    expect(findCheck(snapshot, "guild_admission").passed).toBe(false);
    // Nothing configured at all, which is a different report from a channel
    // half set up: no step has been taken rather than one left undone.
    expect(snapshot.setupStatus).toBe("not_configured");
  });

  test("an allow-list without a token is half set up", async () => {
    admittedChannelCount = 3;

    const [snapshot] = await runDiscordProbe();

    expect(findCheck(snapshot, "bot_token").passed).toBe(false);
    expect(snapshot.setupStatus).toBe("incomplete");
  });

  test("a token, a live connection and an allow-list read as ready", async () => {
    mockSecureKeys[credentialKey("discord_channel", "bot_token")] = "bot-fake";
    admittedChannelCount = 2;
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
    expect(findCheck(snapshot, "guild_admission").message).toContain(
      "2 channels",
    );
    expect(snapshot.ready).toBe(true);
  });

  test("an empty allow-list is unfinished setup, not a live channel", async () => {
    mockSecureKeys[credentialKey("discord_channel", "bot_token")] = "bot-fake";
    admittedChannelCount = 0;

    const [snapshot] = await runDiscordProbe();

    // A connected socket that admits nothing still drops every guild message,
    // so claiming ready here would promise delivery the gate is refusing.
    const admission = findCheck(snapshot, "guild_admission");
    expect(admission.passed).toBe(false);
    expect(snapshot.setupStatus).toBe("incomplete");
    expect(snapshot.ready).toBe(false);

    // And it is a setup step rather than an outage: direct messages carry no
    // guild and never meet this gate, so the connection itself is fine.
    expect(snapshot.health).not.toBe("failing");
    expect(findCheck(snapshot, "inbound_delivery").passed).toBe(true);
  });

  test("one admitted channel reads in the singular", async () => {
    mockSecureKeys[credentialKey("discord_channel", "bot_token")] = "bot-fake";
    admittedChannelCount = 1;

    const [snapshot] = await runDiscordProbe();

    expect(findCheck(snapshot, "guild_admission").message).toContain(
      "1 channel",
    );
    expect(findCheck(snapshot, "guild_admission").message).not.toContain(
      "1 channels",
    );
  });

  test("an unreachable gateway does not claim the allow-list is empty", async () => {
    mockSecureKeys[credentialKey("discord_channel", "bot_token")] = "bot-fake";
    admittedChannelCount = new Error("gateway down");

    const [snapshot] = await runDiscordProbe();

    const admission = findCheck(snapshot, "guild_admission");
    expect(admission.passed).toBe(true);
    expect(admission.indeterminate).toBe(true);
  });

  test("a dead socket reads as configured and failing, not unconfigured", async () => {
    mockSecureKeys[credentialKey("discord_channel", "bot_token")] = "bot-fake";
    // Setup has to be finished for this to isolate the socket: an empty
    // allow-list would leave it incomplete for a reason that is not the socket.
    admittedChannelCount = 1;
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
