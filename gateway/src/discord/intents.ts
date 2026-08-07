/**
 * Discord Gateway intents — the bitmask sent in the IDENTIFY payload.
 *
 * An intent is a subscription: Discord only delivers event families whose
 * intent bit is set. Three of them are *privileged* — they require a toggle in
 * the developer portal, and past a size threshold Discord must approve the app
 * before the toggle stays on. {@link PRIVILEGED_DISCORD_INTENTS} is that set,
 * and a test pins it against this table so the two cannot drift.
 *
 * https://docs.discord.com/developers/events/gateway#gateway-intents
 */

export const DISCORD_INTENTS = {
  /** Guild lifecycle + the guild/channel list in READY. */
  GUILDS: 1 << 0,
  /** PRIVILEGED. `GUILD_MEMBER_*` events. */
  GUILD_MEMBERS: 1 << 1,
  /** PRIVILEGED. Presence and status updates. */
  GUILD_PRESENCES: 1 << 8,
  /** `MESSAGE_CREATE` / `MESSAGE_UPDATE` / `MESSAGE_DELETE` in guild channels. */
  GUILD_MESSAGES: 1 << 9,
  /** The same message events, in DM channels. */
  DIRECT_MESSAGES: 1 << 12,
  /** PRIVILEGED. Populates `content` / `embeds` / `attachments` / `components`. */
  MESSAGE_CONTENT: 1 << 15,
} as const;

/**
 * Intents this client identifies with.
 *
 * `MESSAGE_CONTENT` is deliberately absent. Without it `MESSAGE_CREATE` still
 * arrives for every message in a subscribed channel, but `content` is empty —
 * *except* for messages that mention the bot, messages in DMs, and the bot's
 * own messages, which Discord exempts from the restriction. This client is
 * mention-gated (see `admit.ts`), so every message it acts on falls inside the
 * exemption and carries real content. Requesting the privileged intent would
 * buy nothing and would put the app under portal approval and the annual
 * reapplication Discord introduced in June 2026.
 *
 * That exemption is also a ceiling, not just a convenience: reading messages
 * the bot is *not* mentioned in — the broader "monitor the whole community"
 * shape — cannot be done on this bitmask. It needs `MESSAGE_CONTENT` and the
 * approval that now comes with it.
 *
 * `GUILD_MEMBERS` is absent for the same reason: nothing here reads member
 * events, and it carries the same privileged cost.
 *
 * `DIRECT_MESSAGES` is present because the assistant needs a private lane to
 * one person: a verification code is delivered to a DM and answered there, and
 * guardian outcome notices go to a DM rather than the room. It is not
 * privileged, and DMs are inside the content exemption, so it costs nothing
 * that `MESSAGE_CONTENT` would. Which DMs are acted on is `admit.ts`'s
 * decision, not this bitmask's.
 */
export const DISCORD_GATEWAY_INTENTS =
  DISCORD_INTENTS.GUILDS |
  DISCORD_INTENTS.GUILD_MESSAGES |
  DISCORD_INTENTS.DIRECT_MESSAGES;

/** Intents Discord gates behind a portal toggle and, past a size threshold, approval. */
export const PRIVILEGED_DISCORD_INTENTS = [
  DISCORD_INTENTS.GUILD_MEMBERS,
  DISCORD_INTENTS.GUILD_PRESENCES,
  DISCORD_INTENTS.MESSAGE_CONTENT,
] as const;
