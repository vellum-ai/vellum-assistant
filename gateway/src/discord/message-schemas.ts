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

import { z } from "zod";

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

/** MESSAGE_CREATE dispatch data — the fields admission and normalization read. */
export const DiscordMessageCreateSchema = z.object({
  id: idString(),
  channel_id: idString(),
  guild_id: optionalString(),
  /** Empty (not absent) on non-exempt messages without MESSAGE_CONTENT. */
  content: z.string().catch(""),
  author: z
    .object({
      id: idString(),
      username: optionalString(),
      global_name: z.string().nullable().optional().catch(undefined),
      /**
       * Bot indicator — fails CLOSED, unlike the tolerant fields around it.
       * Absent stays `undefined` (Discord omits it for humans), but a
       * present-and-malformed value collapses to `true`: this is the one
       * classifier standing between the admission gate and a bot reply loop,
       * and collapsing to `undefined` would read as human.
       */
      bot: z.boolean().optional().catch(true),
    })
    .optional()
    .catch(undefined),
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
});
export type DiscordMessageCreate = z.infer<typeof DiscordMessageCreateSchema>;
