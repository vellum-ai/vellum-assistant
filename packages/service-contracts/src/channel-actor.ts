/**
 * `ChannelActor`: the durable identity of the peer who sent a message.
 *
 * This is what trust classification, guardian binding, and contact matching key
 * on, which is exactly the split the gateway already documents: "trust and
 * guardian decisions must be keyed on `actorExternalId` only, never fall back
 * to `conversationExternalId`". The conversation the message arrived in is
 * {@link ChannelAddress} in `./channel-address.js`.
 *
 * Actor coordinates are identity, not routing. Nothing here changes when a
 * thread moves or a callback URL is reissued, and nothing that routes a reply
 * belongs on it.
 *
 * Variants use the same frame and the same validators as the address union, so
 * a Slack user id is checked by the same prefix rule wherever it appears and
 * the projection behaves identically for both.
 */

import { z } from "zod";

import {
  decimalId,
  formatFrame,
  opaqueId,
  parseFrame,
  slackEnterpriseId,
  slackTeamId,
  slackUserId,
  waId,
  e164,
} from "./channel-coordinates.js";
import type { ChannelId } from "./channels.js";

// ---------------------------------------------------------------------------
// Per-channel actor identities
// ---------------------------------------------------------------------------

/** Slack user ids are unique only within a workspace, so the workspace scopes them. */
export const SlackChannelActorSchema = z.strictObject({
  channel: z.literal("slack"),
  scope: z.strictObject({
    teamId: slackTeamId(),
    enterpriseId: slackEnterpriseId().optional(),
  }),
  coordinates: z.strictObject({
    /** Slack user id (`U…`, or `W…` on grid). */
    userId: slackUserId(),
  }),
});

/**
 * Telegram user ids are global to the Bot API, so an actor needs no scope even
 * though a Telegram conversation does: which bot saw the message decides which
 * chat is meant, not who the person is.
 */
export const TelegramChannelActorSchema = z.strictObject({
  channel: z.literal("telegram"),
  coordinates: z.strictObject({
    /** Bot API `from.id`. Always positive for a user. */
    userId: decimalId(19),
  }),
});

/** Discord user snowflakes are global; the guild says where they were seen. */
export const DiscordChannelActorSchema = z.strictObject({
  channel: z.literal("discord"),
  coordinates: z.strictObject({
    userId: decimalId(20),
  }),
});

/** The sender's own WhatsApp number, canonicalized to E.164. */
export const WhatsAppChannelActorSchema = z.strictObject({
  channel: z.literal("whatsapp"),
  coordinates: z.strictObject({
    waId: waId(),
  }),
});

/**
 * An email address is globally unique, and which of our mailboxes they wrote to
 * scopes the conversation rather than the person. Lower cased to match the
 * `COLLATE NOCASE` matching the contact store already applies.
 */
export const EmailChannelActorSchema = z.strictObject({
  channel: z.literal("email"),
  coordinates: z.strictObject({
    address: z.email().max(320).toLowerCase(),
  }),
});

/** Phone numbers are globally unique; our number scopes the conversation. */
export const PhoneChannelActorSchema = z.strictObject({
  channel: z.literal("phone"),
  coordinates: z.strictObject({
    e164: e164(),
  }),
});

/**
 * The local human actor, identified by the principal id the gateway mints at
 * guardian bootstrap. This is what `contact_channels` stores as the `vellum`
 * address.
 */
export const VellumChannelActorSchema = z.strictObject({
  channel: z.literal("vellum"),
  coordinates: z.strictObject({
    principalId: opaqueId(),
  }),
});

/**
 * `platform` mints no identity of its own: the principal a push targets
 * (`target_guardian_principal_id`) is resolved from the `vellum` guardian
 * binding, so a `platform` actor and a `vellum` actor can denote one person.
 */
export const PlatformChannelActorSchema = z.strictObject({
  channel: z.literal("platform"),
  scope: z.strictObject({
    platformAssistantId: opaqueId(),
  }),
  coordinates: z.strictObject({
    /** The `vellum` principal this relay delivers to. */
    principalId: opaqueId(),
  }),
});

/** The peer assistant itself is the actor on an A2A conversation. */
export const A2aChannelActorSchema = z.strictObject({
  channel: z.literal("a2a"),
  coordinates: z.strictObject({
    assistantId: opaqueId().toLowerCase(),
  }),
});

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

/**
 * Actor variant per canonical channel. Same exhaustiveness gate as the address
 * union: a new `CHANNEL_IDS` entry fails to compile until both its conversation
 * address and its actor identity are spelled out.
 */
export const CHANNEL_ACTOR_SCHEMAS = {
  a2a: A2aChannelActorSchema,
  discord: DiscordChannelActorSchema,
  email: EmailChannelActorSchema,
  phone: PhoneChannelActorSchema,
  platform: PlatformChannelActorSchema,
  slack: SlackChannelActorSchema,
  telegram: TelegramChannelActorSchema,
  vellum: VellumChannelActorSchema,
  whatsapp: WhatsAppChannelActorSchema,
} as const satisfies Record<ChannelId, z.ZodObject>;

export const ChannelActorSchema = z.discriminatedUnion("channel", [
  CHANNEL_ACTOR_SCHEMAS.a2a,
  CHANNEL_ACTOR_SCHEMAS.discord,
  CHANNEL_ACTOR_SCHEMAS.email,
  CHANNEL_ACTOR_SCHEMAS.phone,
  CHANNEL_ACTOR_SCHEMAS.platform,
  CHANNEL_ACTOR_SCHEMAS.slack,
  CHANNEL_ACTOR_SCHEMAS.telegram,
  CHANNEL_ACTOR_SCHEMAS.vellum,
  CHANNEL_ACTOR_SCHEMAS.whatsapp,
]);

export type ChannelActor = z.infer<typeof ChannelActorSchema>;

/** The actor variant for one channel, e.g. `ChannelActorFor<"slack">`. */
export type ChannelActorFor<C extends ChannelId> = Extract<
  ChannelActor,
  { channel: C }
>;

// ---------------------------------------------------------------------------
// String projection
// ---------------------------------------------------------------------------

/**
 * Project an actor onto its canonical string form, using the same syntax as an
 * address projection.
 *
 * @throws {z.ZodError} when the actor is not a valid {@link ChannelActor}.
 */
export function formatChannelActor(actor: ChannelActor): string {
  const canonical = ChannelActorSchema.parse(actor);
  return formatFrame(
    canonical.channel,
    "scope" in canonical ? canonical.scope : undefined,
    canonical.coordinates,
  );
}

/** Inverse of {@link formatChannelActor}. Returns `null` on anything invalid. */
export function safeParseChannelActor(text: string): ChannelActor | null {
  const frame = parseFrame(text);
  if (frame === null) {
    return null;
  }
  const result = ChannelActorSchema.safeParse(frame);
  return result.success ? result.data : null;
}

/**
 * Inverse of {@link formatChannelActor}, throwing instead of returning `null`.
 * The message omits the input, which carries an email address or phone number.
 */
export function parseChannelActor(text: string): ChannelActor {
  const actor = safeParseChannelActor(text);
  if (actor === null) {
    throw new Error("not a valid channel actor projection");
  }
  return actor;
}
