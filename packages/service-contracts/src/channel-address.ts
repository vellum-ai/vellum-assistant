/**
 * `ChannelAddress`: the provider conversation or thread a message belongs to.
 *
 * An address answers "which conversation, on which channel, inside which
 * provider account". It is the routing-bearing half of the channel contract:
 * adapter selection and credential resolution are derived from it, and a thread
 * or topic is part of the address rather than an attribute hanging off it, so a
 * reply lands where the message came from.
 *
 * It is deliberately not the sender. Who sent a message is
 * {@link ChannelActor} in `./channel-actor.js`, and the envelope carries both:
 * one conversation can carry many actors, and one actor appears in many
 * conversations, so collapsing them loses whichever side you did not key on.
 *
 * Every variant uses the shared frame from `./channel-coordinates.js`
 * (`channel` / `scope` / `coordinates`), which is also what the string
 * projection and the capability annotations are computed from, so none of the
 * three can drift from the others.
 *
 * Thread coordinates are optional where the provider makes threading optional:
 * a Slack message outside a thread has no `threadTs`, a Telegram chat outside a
 * forum has no `topicId`, and a Discord message outside a thread has no
 * `threadId`. Optional means "this conversation is not threaded", not "the
 * producer may omit it".
 */

import { z } from "zod";

import {
  decimalId,
  formatFrame,
  opaqueId,
  parseFrame,
  signedDecimalId,
  slackConversationId,
  slackEnterpriseId,
  slackTeamId,
  slackThreadTs,
  waId,
  e164,
} from "./channel-coordinates.js";
import type { ChannelId } from "./channels.js";

// ---------------------------------------------------------------------------
// Per-channel conversation addresses
// ---------------------------------------------------------------------------

/**
 * Slack conversations are unique only within a workspace, so the workspace is
 * part of the address. `enterpriseId` is present only on Enterprise Grid
 * installations and is optional for that reason, not because it is
 * discretionary: a producer that has it must include it.
 */
export const SlackChannelAddressSchema = z.strictObject({
  channel: z.literal("slack"),
  scope: z.strictObject({
    /** Workspace id (`T…`). */
    teamId: slackTeamId(),
    /** Enterprise Grid org id (`E…`), on grid installations only. */
    enterpriseId: slackEnterpriseId().optional(),
  }),
  coordinates: z.strictObject({
    /** Conversation id: `C…` channel, `D…` DM, `G…` private or group. */
    conversationId: slackConversationId(),
    /** `thread_ts` of the parent message, on a threaded reply only. */
    threadTs: slackThreadTs().optional(),
  }),
});

/**
 * The bot is the Telegram installation: a chat id means nothing without knowing
 * which bot it was seen by, and two bots in one deployment address different
 * conversations with the same numeric chat id. `botId` is the numeric prefix of
 * the bot token (`<botId>:<secret>`), so a producer can derive it without a
 * `getMe` round trip.
 */
export const TelegramChannelAddressSchema = z.strictObject({
  channel: z.literal("telegram"),
  scope: z.strictObject({
    /** Bot account id, the numeric prefix of the bot token. */
    botId: decimalId(19),
  }),
  coordinates: z.strictObject({
    /** Bot API `chat.id`. Negative for groups, supergroups, and channels. */
    chatId: signedDecimalId(19),
    /** Bot API `message_thread_id`, in a forum topic only. */
    topicId: decimalId(19).optional(),
  }),
});

/**
 * Discord scopes a channel by both the application that saw it and the guild it
 * lives in. `guildId` is required because the admission gate drops anything
 * that is not a guild message (`not_a_guild_message` in `discord/admit.ts`), so
 * a DM never reaches the point of needing an address; admitting DMs would be a
 * policy change that adds a variant here rather than loosening this one.
 */
export const DiscordChannelAddressSchema = z.strictObject({
  channel: z.literal("discord"),
  scope: z.strictObject({
    /** Bot application snowflake. */
    applicationId: decimalId(20),
    /** Guild (server) snowflake. */
    guildId: decimalId(20),
  }),
  coordinates: z.strictObject({
    /** Parent channel snowflake, which is the channel itself outside a thread. */
    channelId: decimalId(20),
    /** Thread or forum-post snowflake, on a thread message only. */
    threadId: decimalId(20).optional(),
  }),
});

/**
 * A WhatsApp conversation is the pair of our business number and the peer's.
 * The business phone number that received the message is the installation: the
 * same person messaging two of our numbers is two conversations, and a reply is
 * only valid from the number they wrote to.
 */
export const WhatsAppChannelAddressSchema = z.strictObject({
  channel: z.literal("whatsapp"),
  scope: z.strictObject({
    /** Cloud API `metadata.phone_number_id` of the receiving business number. */
    businessPhoneNumberId: decimalId(32),
  }),
  coordinates: z.strictObject({
    /** The peer's `wa_id`, canonicalized to E.164. */
    chatId: waId(),
  }),
});

/**
 * An email conversation is a thread, scoped by the mailbox that received it:
 * the same thread reaching two of our addresses is two conversations, and the
 * mailbox is what a reply is sent from.
 */
export const EmailChannelAddressSchema = z.strictObject({
  channel: z.literal("email"),
  scope: z.strictObject({
    /** The receiving address, lower cased. */
    mailbox: z.email().max(320).toLowerCase(),
  }),
  coordinates: z.strictObject({
    /** Thread id the ingress pipeline resolved for this message. */
    threadId: opaqueId(),
  }),
});

/**
 * A phone conversation is the pair of numbers, not a single call: a second call
 * from the same person continues the same conversation, so the call id is a
 * per-event coordinate rather than part of the address.
 */
export const PhoneChannelAddressSchema = z.strictObject({
  channel: z.literal("phone"),
  scope: z.strictObject({
    /** Our Twilio number, in E.164. */
    assistantNumber: e164(),
  }),
  coordinates: z.strictObject({
    /** The peer's number, in E.164. */
    peerNumber: e164(),
  }),
});

/**
 * Native app conversations. A self-hosted assistant is its own installation, so
 * there is no external account to scope by, and the conversation is the
 * assistant's own conversation record.
 */
export const VellumChannelAddressSchema = z.strictObject({
  channel: z.literal("vellum"),
  coordinates: z.strictObject({
    conversationId: opaqueId(),
  }),
});

/**
 * Platform push relay.
 *
 * `platform` owns no conversation of its own. It is a delivery relay whose
 * conversations belong to the `vellum` channel (`conversationStrategy:
 * "push_only"`), so its address is the `vellum` conversation a push deep-links
 * to, scoped by the platform-side assistant id the dispatch is addressed to.
 * A `platform` address and a `vellum` address can therefore denote one
 * conversation. Encoding that borrowing explicitly is the honest reading of the
 * current vocabulary; inventing a platform-native conversation would not be.
 */
export const PlatformChannelAddressSchema = z.strictObject({
  channel: z.literal("platform"),
  scope: z.strictObject({
    /** Platform-side assistant id the push dispatch is addressed to. */
    platformAssistantId: opaqueId(),
  }),
  coordinates: z.strictObject({
    /** The `vellum` conversation this relay delivers into. */
    conversationId: opaqueId(),
  }),
});

/**
 * Assistant-to-assistant peers. The conversation is the peer relationship; the
 * peer's `gatewayUrl` is where a reply is delivered and is re-registered
 * whenever their ingress moves, so it is transport rather than address.
 */
export const A2aChannelAddressSchema = z.strictObject({
  channel: z.literal("a2a"),
  coordinates: z.strictObject({
    /** The peer assistant's id, lower cased, matching how invites store it. */
    peerAssistantId: opaqueId().toLowerCase(),
  }),
});

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

/**
 * Address variant per canonical channel.
 *
 * The `satisfies Record<ChannelId, …>` annotation is the exhaustiveness gate:
 * adding an id to `CHANNEL_IDS` fails to compile here until its conversation
 * address is spelled out, and a variant for a channel that is not canonical
 * fails too. `channel-address.test.ts` pins the union below to this map, since
 * `z.discriminatedUnion` takes a tuple that the map's value type cannot supply.
 */
export const CHANNEL_ADDRESS_SCHEMAS = {
  a2a: A2aChannelAddressSchema,
  discord: DiscordChannelAddressSchema,
  email: EmailChannelAddressSchema,
  phone: PhoneChannelAddressSchema,
  platform: PlatformChannelAddressSchema,
  slack: SlackChannelAddressSchema,
  telegram: TelegramChannelAddressSchema,
  vellum: VellumChannelAddressSchema,
  whatsapp: WhatsAppChannelAddressSchema,
} as const satisfies Record<ChannelId, z.ZodObject>;

export const ChannelAddressSchema = z.discriminatedUnion("channel", [
  CHANNEL_ADDRESS_SCHEMAS.a2a,
  CHANNEL_ADDRESS_SCHEMAS.discord,
  CHANNEL_ADDRESS_SCHEMAS.email,
  CHANNEL_ADDRESS_SCHEMAS.phone,
  CHANNEL_ADDRESS_SCHEMAS.platform,
  CHANNEL_ADDRESS_SCHEMAS.slack,
  CHANNEL_ADDRESS_SCHEMAS.telegram,
  CHANNEL_ADDRESS_SCHEMAS.vellum,
  CHANNEL_ADDRESS_SCHEMAS.whatsapp,
]);

export type ChannelAddress = z.infer<typeof ChannelAddressSchema>;

/** The address variant for one channel, e.g. `ChannelAddressFor<"slack">`. */
export type ChannelAddressFor<C extends ChannelId> = Extract<
  ChannelAddress,
  { channel: C }
>;

// ---------------------------------------------------------------------------
// String projection
// ---------------------------------------------------------------------------

/**
 * Project an address onto its canonical string form.
 *
 * The address is validated first, so the output is always the projection of a
 * canonical address: a caller that hands over a bare-digit `wa_id` gets the
 * projection of its E.164 form rather than a second spelling.
 *
 * @throws {z.ZodError} when the address is not a valid {@link ChannelAddress}.
 */
export function formatChannelAddress(address: ChannelAddress): string {
  const canonical = ChannelAddressSchema.parse(address);
  return formatFrame(
    canonical.channel,
    "scope" in canonical ? canonical.scope : undefined,
    canonical.coordinates,
  );
}

/**
 * Inverse of {@link formatChannelAddress}. Returns `null` for anything that is
 * not a projection of a valid address: an unknown channel, a duplicated or
 * unknown field, a broken percent-escape, a coordinate that fails its own
 * format, or a channel's scope block being absent when it is required.
 */
export function safeParseChannelAddress(text: string): ChannelAddress | null {
  const frame = parseFrame(text);
  if (frame === null) {
    return null;
  }
  const result = ChannelAddressSchema.safeParse(frame);
  return result.success ? result.data : null;
}

/**
 * Inverse of {@link formatChannelAddress}, throwing instead of returning
 * `null`. The message deliberately omits the input: a projection carries an
 * email address or a phone number, and a parse failure is not a reason to put
 * one in a log line.
 */
export function parseChannelAddress(text: string): ChannelAddress {
  const address = safeParseChannelAddress(text);
  if (address === null) {
    throw new Error("not a valid channel address projection");
  }
  return address;
}
