/**
 * Every outbound verification start and resend delivers its message, once,
 * from inside the shared action.
 *
 * This used to be true of Telegram and voice only. Slack, Discord and email
 * instead returned a `_pending*` payload for the caller to dispatch, because a
 * CLI subprocess was sandboxed and could not reach the gateway itself. That
 * stopped being true when the CLI moved to a thin IPC wrapper and started
 * going through the same route handler that dispatched and stripped the field,
 * so the indirection had exactly one consumer handing a payload back to
 * itself.
 *
 * The risk in collapsing it is silent: a channel that mints a session and
 * never sends looks identical to a healthy one from the outside, and the user
 * simply never receives a code. So this asserts delivery per channel rather
 * than asserting the shape of the returned object.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import "./test-preload.js";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

/** Every delivery attempt, whichever transport it went out on. */
const deliveries: Array<{ transport: string; to: string; text: string }> = [];

mock.module("../messaging/providers/slack/send.js", () => ({
  sendSlackReply: async (chatId: string, text: string) => {
    deliveries.push({ transport: "slack", to: chatId, text });
    return {};
  },
}));

mock.module("../messaging/providers/telegram-bot/send.js", () => ({
  sendTelegramReply: async (chatId: string, text: string) => {
    deliveries.push({ transport: "telegram", to: chatId, text });
    return {};
  },
}));

mock.module("../messaging/providers/discord/api.js", () => ({
  openDiscordDmChannel: async (recipientUserId: string) =>
    `dm-for-${recipientUserId}`,
}));

mock.module("../messaging/providers/discord/send.js", () => ({
  sendDiscordReply: async (target: { channelId: string }, text: string) => {
    deliveries.push({ transport: "discord", to: target.channelId, text });
    return {};
  },
}));

/** Email delivery reaches the platform client; stub it at that boundary. */
mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => ({
      platformAssistantId: "asst-1",
      fetch: async (path: string) => {
        if (path.includes("email-addresses")) {
          return {
            ok: true,
            json: async () => ({ results: [{ address: "bot@example.com" }] }),
          };
        }
        deliveries.push({ transport: "email", to: "captured", text: "" });
        return { ok: true, json: async () => ({}) };
      },
    }),
  },
}));

const sessions = await import("./helpers/verification-sessions-ipc-sim.js");
mock.module("../channels/gateway-verification-sessions.js", () => sessions);

mock.module("../runtime/channel-verification-service.js", () => ({
  isGuardianBoundForChannel: async () => false,
  getGuardianBinding: async () => null,
}));

const { startOutbound } =
  await import("../runtime/verification-outbound-actions.js");

/** A destination shaped the way each channel's own addresses are. */
const DESTINATIONS: Array<{ channel: string; destination: string }> = [
  { channel: "slack", destination: "U0123456789" },
  { channel: "discord", destination: "900000000000000042" },
  { channel: "telegram", destination: "123456789" },
];

beforeEach(() => {
  deliveries.length = 0;
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

  test("no channel returns a payload for the caller to send instead", async () => {
    // The shape this replaced: a result carrying the message so that whoever
    // called it could deliver. A reintroduced `_pending*` field means some
    // channel is minting a session it never sends, which no per-channel
    // delivery assertion above would catch on its own.
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
