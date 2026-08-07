/**
 * The Discord private-delivery lane, asserted against a stubbed fetch.
 *
 * Discord has no route that looks a DM up by recipient, so reaching one person
 * is always "open the channel, then post to it". Two things about that are
 * silent when wrong and are pinned here: the open call must use the documented
 * create-DM route, and a delivery marked `dm` must post to the channel that
 * call returned rather than to the id it was handed. The second is the one
 * that matters: the id handed in is a *user* snowflake, and a Discord user id
 * and channel id are both bare digits, so posting it unresolved does not fail
 * loudly. It either 404s or, worse, addresses whatever channel happens to
 * carry that id.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const BOT_TOKEN = "discord-bot-token";

const realSecureKeys = await import("../../../security/secure-keys.js");
mock.module("../../../security/secure-keys.js", () => ({
  ...realSecureKeys,
  getSecureKeyResultAsync: async () => ({
    value: BOT_TOKEN,
    unreachable: false,
  }),
}));

// Pulled in by `send.js`; stubbed so importing the transport does not reach
// the attachment store. No test here sends an attachment.
mock.module("../../../persistence/attachments-store.js", () => ({
  getAttachmentContent: () => null,
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const { openDiscordDmChannel, resetDiscordDmChannelCache } =
  await import("./api.js");
const { discordTransport } = await import("./transport.js");

const originalFetch = globalThis.fetch;

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

let calls: Captured[] = [];

/** The user snowflake a notice is addressed to. */
const RECIPIENT = "900000000000000042";
/** The DM channel Discord hands back for that recipient. */
const DM_CHANNEL = "800000000000000099";
/** The public guild channel the requester was seen in. */
const GUILD_CHANNEL = "700000000000000001";

/**
 * Answer the create-DM route with a channel and every other route with a
 * message. Keyed on the route so a mis-routed call is visible as a wrong
 * payload rather than quietly succeeding.
 */
function stubFetch(): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({
      url: href,
      method: init?.method ?? "GET",
      body: init?.body,
    });
    const payload = href.endsWith("/users/@me/channels")
      ? { id: DM_CHANNEL }
      : { id: "msg-1" };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  resetDiscordDmChannelCache();
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("openDiscordDmChannel", () => {
  test("POSTs the documented create-DM route with recipient_id", async () => {
    const channelId = await openDiscordDmChannel(RECIPIENT);

    expect(channelId).toBe(DM_CHANNEL);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://discord.com/api/v10/users/@me/channels");
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(String(calls[0].body))).toEqual({
      recipient_id: RECIPIENT,
    });
  });

  test("resolves a repeat recipient without a second API call", async () => {
    // Discord returns the existing channel rather than opening a second, so
    // this is not about correctness. It is about the documented rate limit:
    // a bot that opens DMs too quickly gets blocked from opening new ones,
    // and a per-notice lane would re-open on every delivery.
    await openDiscordDmChannel(RECIPIENT);
    await openDiscordDmChannel(RECIPIENT);
    await openDiscordDmChannel(RECIPIENT);

    expect(calls).toHaveLength(1);
  });

  test("concurrent opens for one recipient share a single request", async () => {
    // The cache cannot help here: nothing has populated it yet. A verification
    // send and a guardian notice can address the same person in one tick, and
    // Discord blocks a bot that opens DMs too quickly.
    const [a, b, c] = await Promise.all([
      openDiscordDmChannel(RECIPIENT),
      openDiscordDmChannel(RECIPIENT),
      openDiscordDmChannel(RECIPIENT),
    ]);

    expect(calls).toHaveLength(1);
    expect([a, b, c]).toEqual([DM_CHANNEL, DM_CHANNEL, DM_CHANNEL]);
  });

  test("a channel-less answer throws, and is not pinned for later callers", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(openDiscordDmChannel(RECIPIENT)).rejects.toThrow(
      /no channel id/i,
    );

    // A transient failure must not leave every later caller sharing the
    // rejected promise.
    stubFetch();
    await expect(openDiscordDmChannel(RECIPIENT)).resolves.toBe(DM_CHANNEL);
  });

  test("opens a separate channel per recipient", async () => {
    await openDiscordDmChannel(RECIPIENT);
    await openDiscordDmChannel("900000000000000043");

    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1].body))).toEqual({
      recipient_id: "900000000000000043",
    });
  });

});

describe("discordTransport with dm=1", () => {
  test("delivers to the opened DM channel, never to the id it was handed", async () => {
    await discordTransport.deliver(
      { callbackUrl: "/deliver/discord?dm=1", params: { dm: "1" } },
      { chatId: RECIPIENT, text: "Your access request was declined." },
    );

    const messageCalls = calls.filter((c) => c.url.includes("/messages"));
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0].url).toBe(
      `https://discord.com/api/v10/channels/${DM_CHANNEL}/messages`,
    );
    // The recipient's own snowflake must never appear as a channel in the
    // route: that is the unresolved-user-id delivery this lane exists to stop.
    expect(messageCalls[0].url).not.toContain(RECIPIENT);
  });

  test("a dm delivery ignores threadId, which addresses a guild thread", async () => {
    await discordTransport.deliver(
      {
        callbackUrl: "/deliver/discord?dm=1",
        params: { dm: "1", threadId: "700000000000000009" },
      },
      { chatId: RECIPIENT, text: "expired" },
    );

    const messageCalls = calls.filter((c) => c.url.includes("/messages"));
    expect(messageCalls[0].url).toContain(DM_CHANNEL);
    expect(messageCalls[0].url).not.toContain("700000000000000009");
  });

  test("without dm, chatId is still a channel and no DM is opened", async () => {
    // The ordinary in-channel reply must not start routing through a DM.
    await discordTransport.deliver(
      { callbackUrl: "/deliver/discord", params: {} },
      { chatId: GUILD_CHANNEL, text: "hello" },
    );

    expect(calls.some((c) => c.url.endsWith("/users/@me/channels"))).toBe(
      false,
    );
    expect(calls[0].url).toBe(
      `https://discord.com/api/v10/channels/${GUILD_CHANNEL}/messages`,
    );
  });
});
