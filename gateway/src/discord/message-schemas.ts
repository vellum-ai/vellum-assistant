/**
 * Tolerant Zod schemas for Discord Gateway payloads.
 *
 * Gateway frames are untrusted external input. Each schema validates the
 * types of the fields the client reads while staying tolerant: a malformed
 * optional field collapses to `undefined` (or `""` for required ids) rather
 * than rejecting the payload, so downstream null-checks drop an unprocessable
 * frame individually instead of crashing the connection. Unknown keys are
 * stripped from the parsed working copy; the normalizer preserves the
 * original payload verbatim as `raw`.
 *
 * Absent-vs-empty matters here. Without the MESSAGE_CONTENT intent,
 * non-exempt messages arrive with `content` / `embeds` / `attachments` /
 * `components` **empty** but `poll` **omitted** — so nothing below requires
 * those fields, and an empty-content MESSAGE_CREATE is an ordinary frame, not
 * a schema violation. Messages this client acts on (mentions of the bot) are
 * inside Discord's content exemption and carry real content.
 *
 * https://docs.discord.com/developers/events/gateway-events
 */

import type {
  APIMessageComponentButtonInteraction,
  APIThreadChannel,
  GatewayHelloData,
  GatewayMessageCreateDispatchData,
  GatewayMessageDeleteDispatchData,
  GatewayMessageReactionAddDispatchData,
  GatewayMessageReactionRemoveDispatchData,
  GatewayMessageUpdateDispatchData,
  GatewayReadyDispatchData,
  GatewayReceivePayload,
} from "discord-api-types/v10";
import { z } from "zod";

import type {
  Expect,
  ModeledKeysAreOfficial,
  OfficialValueSatisfiesOurs,
} from "../webhook-crosscheck.js";

const optionalString = () => z.string().optional().catch(undefined);
const optionalNumber = () => z.number().optional().catch(undefined);
/** A required id string: a missing/non-string value collapses to `""`. */
const idString = () => z.string().catch("");

/**
 * The outer Gateway frame. `op` is the discriminator; `d` stays `unknown`
 * because its shape depends on op and event type, and each handler parses it
 * with the specific schema below. `s` is the sequence number (null on
 * non-dispatch frames) and `t` the dispatch event name.
 */
export const DiscordGatewayPayloadSchema = z.object({
  op: optionalNumber(),
  d: z.unknown(),
  s: z.number().nullable().optional().catch(undefined),
  t: z.string().nullable().optional().catch(undefined),
});

/** op 10 HELLO data. */
export const DiscordHelloSchema = z.object({
  heartbeat_interval: optionalNumber(),
});

/** READY dispatch data — the fields that make a session resumable. */
export const DiscordReadySchema = z.object({
  session_id: idString(),
  resume_gateway_url: idString(),
  user: z
    .object({
      id: idString(),
      username: optionalString(),
    })
    .optional()
    .catch(undefined),
});

/**
 * A channel object, as carried by GUILD_CREATE / THREAD_* events. Only the
 * fields thread-parent resolution reads.
 */
const DiscordChannelSchema = z.object({
  id: idString(),
  type: optionalNumber(),
  parent_id: z.string().nullable().optional().catch(undefined),
});

/** GUILD_CREATE / THREAD_LIST_SYNC data: the thread lists they carry. */
export const DiscordThreadListSchema = z.object({
  threads: z.array(DiscordChannelSchema).optional().catch(undefined),
});

/** THREAD_CREATE / THREAD_UPDATE / THREAD_DELETE data: one channel object. */
export const DiscordThreadSchema = DiscordChannelSchema;

/**
 * A user object, as carried by message authors and interaction actors. The
 * `bot` indicator fails CLOSED, unlike the tolerant fields around it: absent
 * stays `undefined` (Discord omits it for humans), but a present-and-malformed
 * value collapses to `true`, because this is the classifier standing between
 * ingestion and a bot feedback loop, and collapsing to `undefined` would read
 * as human.
 */
const DiscordUserSchema = z.object({
  id: idString(),
  username: optionalString(),
  global_name: z.string().nullable().optional().catch(undefined),
  bot: z.boolean().optional().catch(true),
});

/** MESSAGE_CREATE dispatch data — the fields admission and normalization read. */
export const DiscordMessageCreateSchema = z.object({
  id: idString(),
  channel_id: idString(),
  /**
   * Guild indicator. Fails CLOSED, like the bot indicators below and unlike
   * the tolerant fields around them.
   *
   * Absence is load-bearing here: it is the only thing that marks a message as
   * a DM, and a DM is admitted without a mention. Collapsing a malformed
   * value to `undefined` would therefore turn
   * a parse failure into a guild message admitted as private, skipping both
   * controls that stand between a public server and the assistant. The
   * sentinel keeps it on the guild path, where it must still clear them.
   */
  guild_id: z.string().optional().catch("malformed-guild-id"),
  /** Empty (not absent) on non-exempt messages without MESSAGE_CONTENT. */
  content: z.string().catch(""),
  /**
   * Set on MESSAGE_UPDATE dispatches; null on a MESSAGE_CREATE and on
   * update dispatches that carry no user revision (embed resolution). Each
   * revision's timestamp makes the edit's dedup id unique per revision, so
   * successive edits of one message are never swallowed as duplicates.
   */
  edited_timestamp: z.string().nullable().optional().catch(undefined),
  author: DiscordUserSchema.optional().catch(undefined),
  /**
   * Present on webhook-delivered messages, whose author is not a real user.
   * Fails closed like `author.bot`: a malformed value collapses to a sentinel
   * rather than `undefined`, so it still reads as webhook-delivered.
   */
  webhook_id: z.string().optional().catch("malformed-webhook-id"),
  /**
   * Users directly mentioned. `@everyone` / `@here` and role pings never
   * appear here — they surface on `mention_everyone` / `mention_roles` — so
   * the bot-id-in-mentions admission trigger is immune to announcement noise.
   */
  mentions: z
    .array(z.object({ id: idString() }))
    .optional()
    .catch(undefined),
  attachments: z
    .array(
      z.object({
        id: idString(),
        filename: optionalString(),
        size: optionalNumber(),
        content_type: optionalString(),
        url: optionalString(),
      }),
    )
    .optional()
    .catch(undefined),
});
export type DiscordMessageCreate = z.infer<typeof DiscordMessageCreateSchema>;

/**
 * MESSAGE_DELETE carries three fields and nothing else: no author, no
 * content, no mentions. The guild sentinel matches the create schema's
 * reasoning: absence means DM, so a malformed value must not read as one.
 */
export const DiscordMessageDeleteSchema = z.object({
  id: idString(),
  channel_id: idString(),
  guild_id: z.string().optional().catch("malformed-guild-id"),
});
export type DiscordMessageDelete = z.infer<typeof DiscordMessageDeleteSchema>;

/**
 * MESSAGE_REACTION_ADD / MESSAGE_REACTION_REMOVE data: the fields the
 * reaction path reads, which both dispatches share (ADD extends REMOVE with
 * member and message-author data this client does not read). A unicode emoji
 * arrives as `{id: null, name: "👍"}` where the name IS the character; a
 * custom emoji carries a snowflake id and its guild-local name, which Discord
 * may null on REMOVE for a deleted emoji. The guild sentinel matches the
 * create schema's reasoning: absence means DM, so a malformed value must not
 * read as one.
 */
export const DiscordMessageReactionSchema = z.object({
  user_id: idString(),
  channel_id: idString(),
  message_id: idString(),
  guild_id: z.string().optional().catch("malformed-guild-id"),
  emoji: z
    .object({
      id: z.string().nullable().optional().catch(undefined),
      name: z.string().nullable().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
export type DiscordMessageReaction = z.infer<
  typeof DiscordMessageReactionSchema
>;

/** InteractionType.MessageComponent: a component press, the one type consumed. */
export const DISCORD_INTERACTION_TYPE_MESSAGE_COMPONENT = 3;
/** ComponentType.Button within a component interaction's data. */
export const DISCORD_COMPONENT_TYPE_BUTTON = 2;
/** InteractionResponseType.DeferredMessageUpdate: ACK without a loading state. */
export const DISCORD_INTERACTION_CALLBACK_DEFERRED_UPDATE = 6;

/**
 * INTERACTION_CREATE data: the fields the component-button path reads.
 * Interactions ride the Gateway by default and need no intent bit; an
 * Interactions Endpoint URL configured in the developer portal would divert
 * them to HTTP and silence this dispatch, so the app must not configure one.
 * The actor arrives as `user` in a DM and as `member.user` in a guild. The
 * guild sentinel matches the create schema's reasoning.
 */
export const DiscordInteractionSchema = z.object({
  id: idString(),
  /** Authorizes the callback ack; it rides in the URL, not a header. */
  token: idString(),
  type: optionalNumber(),
  channel_id: optionalString(),
  guild_id: z.string().optional().catch("malformed-guild-id"),
  data: z
    .object({
      custom_id: idString(),
      component_type: optionalNumber(),
    })
    .optional()
    .catch(undefined),
  /** The message the pressed component is attached to (the card). */
  message: z.object({ id: idString() }).optional().catch(undefined),
  member: z
    .object({ user: DiscordUserSchema.optional().catch(undefined) })
    .optional()
    .catch(undefined),
  user: DiscordUserSchema.optional().catch(undefined),
});
export type DiscordInteraction = z.infer<typeof DiscordInteractionSchema>;

// ---------------------------------------------------------------------------
// Compile-time cross-check against the official Discord API types.
//
// `discord-api-types` is a types-only dev dependency: it contributes nothing at
// runtime (the `import type` above is erased from the build) and the schemas
// above stay the sole runtime validators. Its only job is to make TypeScript
// prove, via the shared `webhook-crosscheck` helpers, that a drift from the
// real Gateway shape fails `tsc` instead of silently mis-parsing a live frame.
//
// This matters more here than on the other channels, because two of the fields
// below fail CLOSED on a malformed value: `guild_id` decides whether a message
// is a DM, and `author.bot` is the one classifier standing between the
// admission gate and a bot reply loop. A field-name typo in either would parse
// to the tolerant branch forever and never announce itself.
type DiscordMessageAuthor = NonNullable<
  z.infer<typeof DiscordMessageCreateSchema>["author"]
>;
type DiscordMessageAttachment = NonNullable<
  z.infer<typeof DiscordMessageCreateSchema>["attachments"]
>[number];

type _DiscordApiCrossChecks = [
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof DiscordGatewayPayloadSchema>,
      GatewayReceivePayload
    >
  >,
  Expect<
    ModeledKeysAreOfficial<z.infer<typeof DiscordHelloSchema>, GatewayHelloData>
  >,
  Expect<
    OfficialValueSatisfiesOurs<
      z.infer<typeof DiscordHelloSchema>,
      GatewayHelloData
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof DiscordReadySchema>,
      GatewayReadyDispatchData
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof DiscordThreadSchema>,
      APIThreadChannel
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof DiscordMessageCreateSchema>,
      GatewayMessageCreateDispatchData
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof DiscordMessageCreateSchema>,
      GatewayMessageUpdateDispatchData
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof DiscordMessageDeleteSchema>,
      GatewayMessageDeleteDispatchData
    >
  >,
  // REMOVE is the narrower dispatch (ADD extends it), so the key check
  // against it proves every modeled field rides both events.
  Expect<
    ModeledKeysAreOfficial<
      DiscordMessageReaction,
      GatewayMessageReactionRemoveDispatchData
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      DiscordMessageReaction,
      GatewayMessageReactionAddDispatchData
    >
  >,
  Expect<
    OfficialValueSatisfiesOurs<
      DiscordMessageReaction,
      GatewayMessageReactionRemoveDispatchData
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      NonNullable<DiscordMessageReaction["emoji"]>,
      GatewayMessageReactionRemoveDispatchData["emoji"]
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      DiscordInteraction,
      APIMessageComponentButtonInteraction
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      NonNullable<DiscordInteraction["data"]>,
      APIMessageComponentButtonInteraction["data"]
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      NonNullable<DiscordInteraction["member"]>,
      NonNullable<APIMessageComponentButtonInteraction["member"]>
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      NonNullable<DiscordInteraction["user"]>,
      NonNullable<APIMessageComponentButtonInteraction["user"]>
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      DiscordMessageAuthor,
      GatewayMessageCreateDispatchData["author"]
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      DiscordMessageAttachment,
      GatewayMessageCreateDispatchData["attachments"][number]
    >
  >,
];
