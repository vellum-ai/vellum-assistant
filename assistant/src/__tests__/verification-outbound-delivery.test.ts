/**
 * Every outbound verification start and resend delivers its message, once,
 * from inside the shared action.
 *
 * The failure this guards is silent. A channel that mints a session and never
 * sends looks identical to a healthy one from the outside: the call succeeds,
 * a session exists, and the user simply never receives a code. Nothing errors
 * and nothing logs, so the only way to catch it is to assert the delivery
 * itself rather than the shape of the returned object.
 *
 * A result must also carry no message for a caller to send on its behalf. A
 * channel whose message leaves in the return value instead of over its
 * transport is one whose delivery depends on every caller remembering to
 * dispatch it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import "./test-preload.js";

// Every mock below spreads the real module before overriding. Replacing a
// module wholesale drops every export the test did not think to list, and the
// failure surfaces as an unrelated import crash in whichever module happens to
// need one of them.
const realEnv = await import("../config/env.js");
mock.module("../config/env.js", () => ({
  ...realEnv,
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

/** Every delivery attempt, whichever transport it went out on. */
const deliveries: Array<{ transport: string; to: string; text: string }> = [];

const realSlackSend = await import("../messaging/providers/slack/send.js");
mock.module("../messaging/providers/slack/send.js", () => ({
  ...realSlackSend,
  sendSlackReply: async (chatId: string, text: string) => {
    deliveries.push({ transport: "slack", to: chatId, text });
    return {};
  },
}));

const realTelegramSend =
  await import("../messaging/providers/telegram-bot/send.js");
mock.module("../messaging/providers/telegram-bot/send.js", () => ({
  ...realTelegramSend,
  sendTelegramReply: async (chatId: string, text: string) => {
    deliveries.push({ transport: "telegram", to: chatId, text });
    return {};
  },
}));

const realDiscordApi = await import("../messaging/providers/discord/api.js");
mock.module("../messaging/providers/discord/api.js", () => ({
  ...realDiscordApi,
  openDiscordDmChannel: async (recipientUserId: string) =>
    `dm-for-${recipientUserId}`,
}));

const realDiscordSend = await import("../messaging/providers/discord/send.js");
mock.module("../messaging/providers/discord/send.js", () => ({
  ...realDiscordSend,
  sendDiscordReply: async (target: { channelId: string }, text: string) => {
    deliveries.push({ transport: "discord", to: target.channelId, text });
    return {};
  },
}));

const sessions = await import("./helpers/verification-sessions-ipc-sim.js");
mock.module("../channels/gateway-verification-sessions.js", () => sessions);

const realVerificationService =
  await import("../runtime/channel-verification-service.js");
mock.module("../runtime/channel-verification-service.js", () => ({
  ...realVerificationService,
  isGuardianBoundForChannel: async () => false,
  getGuardianBinding: async () => null,
}));

const { startOutbound, resendOutbound } =
  await import("../runtime/verification-outbound-actions.js");

/**
 * A destination shaped the way each channel's own addresses are.
 *
 * Email is absent: its transport goes through the platform client, which is a
 * heavier boundary than this file's concern. It reaches delivery through the
 * same shared path as the two spec-driven channels here, so that path is
 * covered.
 */
const DESTINATIONS: Array<{ channel: string; destination: string }> = [
  { channel: "slack", destination: "U0123456789" },
  { channel: "discord", destination: "900000000000000042" },
  { channel: "telegram", destination: "123456789" },
];

beforeEach(() => {
  deliveries.length = 0;
  // Sessions persist in the sim, and `findActiveSession` returns the latest
  // for a channel, so without this a test would resend against the previous
  // test's session.
  sessions.resetVerificationSessionsSim();
});

describe("startOutbound delivers from inside the action", () => {
  for (const { channel, destination } of DESTINATIONS) {
    test(`${channel} sends exactly one message`, async () => {
      const result = await startOutbound({
        channel: channel as never,
        destination,
      });

      expect(result.success).toBe(true);
      const sent = deliveries.filter((d) => d.transport === channel);
      expect(sent).toHaveLength(1);
      expect(sent[0].text.length).toBeGreaterThan(0);
    });
  }

  test("resend delivers too, on every channel that starts", async () => {
    // Start and resend run the same mint-and-send, so this is coverage of that
    // shared path from its second entry point rather than of resend as a
    // feature.
    for (const { channel, destination } of DESTINATIONS) {
      sessions.resetVerificationSessionsSim();
      const start = await startOutbound({
        channel: channel as never,
        destination,
      });
      expect(start.verificationSessionId).toBeDefined();

      // A start stamps a 15-second resend cooldown. That cooldown is its own
      // behaviour; clearing it here is what lets this reach the delivery.
      sessions.updateSessionDelivery(
        start.verificationSessionId!,
        Date.now(),
        1,
        null,
      );
      deliveries.length = 0;

      const result = await resendOutbound({ channel: channel as never });
      expect(result.success).toBe(true);
      expect(deliveries.filter((d) => d.transport === channel)).toHaveLength(1);
    }
  });

  test("no channel returns a payload for the caller to send instead", async () => {
    // A `_pending*` field means some channel is minting a session whose
    // message it never sends, which no per-channel delivery assertion above
    // would catch on its own: that channel simply would not appear.
    for (const { channel, destination } of DESTINATIONS) {
      const result = await startOutbound({
        channel: channel as never,
        destination,
      });
      for (const key of Object.keys(result)) {
        expect(key.startsWith("_pending")).toBe(false);
      }
    }
  });

  test("a Discord code is addressed to the opened DM, not the user id", async () => {
    // The user snowflake has to be resolved to a channel before the send, and
    // both are bare digits, so an unresolved delivery does not fail loudly.
    await startOutbound({
      channel: "discord" as never,
      destination: "900000000000000042",
    });

    const sent = deliveries.filter((d) => d.transport === "discord");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("dm-for-900000000000000042");
  });
});
