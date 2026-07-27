import { z } from "zod";
import type {
  GenericMessageEvent as SlackApiGenericMessageEvent,
  MessageChangedEvent as SlackApiMessageChangedEvent,
  MessageDeletedEvent as SlackApiMessageDeletedEvent,
  ReactionAddedEvent as SlackApiReactionAddedEvent,
  ReactionRemovedEvent as SlackApiReactionRemovedEvent,
} from "@slack/types";
import type { RouteResult } from "../routing/types.js";
import type { GatewayInboundEvent } from "../types.js";
import type {
  Expect,
  ModeledKeysAreOfficial,
  OfficialValueSatisfiesOurs,
} from "../webhook-crosscheck.js";

// Tolerant Zod schemas for untrusted Slack ingress (Socket Mode / Events API),
// their z.infer types, and compile-time cross-checks against @slack/types. A
// malformed field collapses to `undefined` so downstream null-checks drop an
// unprocessable event rather than trusting garbage. See the "Provider Webhook
// Payload Validation" convention in gateway/AGENTS.md.
const optionalString = () => z.string().optional().catch(undefined);
/** A required id string: a missing/non-string value collapses to `""`. */
const requiredString = () => z.string().catch("");

/** Slack file object (subset relevant to attachment handling). */
/** A Slack file attachment; only the fields the gateway forwards are modeled. */
const slackFileSchema = z.object({
  id: requiredString(),
  name: optionalString(),
  mimetype: optionalString(),
  size: z.number().optional().catch(undefined),
  url_private_download: optionalString(),
  url_private: optionalString(),
});
export type SlackFile = z.infer<typeof slackFileSchema>;

/**
 * Slack `bot_profile` object attached to bot-authored messages
 * (subset relevant to sender classification).
 */
const slackBotProfileSchema = z.object({
  id: optionalString(),
  name: optionalString(),
  app_id: optionalString(),
  team_id: optionalString(),
});
export type SlackBotProfile = z.infer<typeof slackBotProfileSchema>;

/** `message.edited` / `previous_message.edited` sub-object. */
const slackEditedSchema = z
  .object({ user: optionalString(), ts: optionalString() })
  .optional()
  .catch(undefined);

/** `channel_type` is a known enum; an unrecognized value collapses to undefined. */
const slackMessageChannelType = () =>
  z.enum(["im", "channel", "group", "mpim"]).optional().catch(undefined);

/** The edited message body carried in a `message_changed` event's `message`. */
const slackChangedMessageSchema = z
  .object({
    user: optionalString(),
    text: optionalString(),
    ts: optionalString(),
    client_msg_id: optionalString(),
    thread_ts: optionalString(),
    edited: slackEditedSchema,
  })
  .optional()
  .catch(undefined);

/** The prior version carried in a `message_changed` event's `previous_message`. */
const slackChangedPreviousMessageSchema = z
  .object({
    user: optionalString(),
    text: optionalString(),
    ts: optionalString(),
    edited: slackEditedSchema,
  })
  .optional()
  .catch(undefined);

/**
 * Slack `message_changed` event — subtype `message_changed` wraps the edited
 * message in `event.message` and the prior version in `event.previous_message`.
 */
export const slackMessageChangedEventSchema = z.object({
  type: optionalString(),
  subtype: optionalString(),
  channel: optionalString(),
  channel_type: slackMessageChannelType(),
  hidden: z.boolean().optional().catch(undefined),
  ts: optionalString(),
  event_ts: optionalString(),
  message: slackChangedMessageSchema,
  previous_message: slackChangedPreviousMessageSchema,
});
export type SlackMessageChangedEvent = z.infer<
  typeof slackMessageChangedEventSchema
>;

/** The prior content carried in a `message_deleted` event's `previous_message`. */
const slackDeletedPreviousMessageSchema = z
  .object({
    user: optionalString(),
    text: optionalString(),
    ts: optionalString(),
    thread_ts: optionalString(),
  })
  .optional()
  .catch(undefined);

/**
 * Slack `message_deleted` event — subtype `message_deleted` carries the
 * original message's `ts` in `event.deleted_ts` and the prior content in
 * `event.previous_message`.
 */
export const slackMessageDeletedEventSchema = z.object({
  type: optionalString(),
  subtype: optionalString(),
  channel: optionalString(),
  channel_type: slackMessageChannelType(),
  hidden: z.boolean().optional().catch(undefined),
  ts: optionalString(),
  event_ts: optionalString(),
  deleted_ts: optionalString(),
  previous_message: slackDeletedPreviousMessageSchema,
});
export type SlackMessageDeletedEvent = z.infer<
  typeof slackMessageDeletedEventSchema
>;

// Compile-time cross-check against the official Slack event types, via the
// shared `webhook-crosscheck` helpers. The tolerant Zod schemas above stay the
// sole runtime validators; these type-only assertions make a field rename fail
// the build. Only key-integrity is asserted at the top level — the official
// `message` / `previous_message` are the broad `MessageEvent` union, so the
// inner edited-message shape is value-checked against the concrete
// `GenericMessageEvent` member instead.
type _SlackMessageApiCrossChecks = [
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof slackMessageChangedEventSchema>,
      SlackApiMessageChangedEvent
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof slackMessageDeletedEventSchema>,
      SlackApiMessageDeletedEvent
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      NonNullable<z.infer<typeof slackChangedMessageSchema>>,
      SlackApiGenericMessageEvent
    >
  >,
  Expect<
    OfficialValueSatisfiesOurs<
      NonNullable<z.infer<typeof slackChangedMessageSchema>>,
      SlackApiGenericMessageEvent
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      NonNullable<z.infer<typeof slackDeletedPreviousMessageSchema>>,
      SlackApiGenericMessageEvent
    >
  >,
];

/**
 * Tolerant schema for the plain-message family — `app_mention`, direct
 * messages, and channel/group messages. The three differ only in discriminator
 * values (`type` / `channel_type`) and which fields the normalizer keys on, so
 * one tolerant shape backs all three; each normalizer applies its own guards.
 */
export const slackMessageEventSchema = z.object({
  type: optionalString(),
  subtype: optionalString(),
  user: optionalString(),
  text: optionalString(),
  ts: optionalString(),
  channel: optionalString(),
  channel_type: slackMessageChannelType(),
  thread_ts: optionalString(),
  client_msg_id: optionalString(),
  event_ts: optionalString(),
  files: z.array(slackFileSchema).optional().catch(undefined),
  team: optionalString(),
  bot_id: optionalString(),
  bot_profile: slackBotProfileSchema.optional().catch(undefined),
});
export type SlackMessageEvent = z.infer<typeof slackMessageEventSchema>;

/** All three plain-message events share the one tolerant shape. */
export type SlackAppMentionEvent = SlackMessageEvent;
export type SlackDirectMessageEvent = SlackMessageEvent;
export type SlackChannelMessageEvent = SlackMessageEvent;

// Key-integrity cross-check against the official `GenericMessageEvent` (a
// superset of the fields all three plain-message events carry). Value-checking
// is skipped here because `@slack/types` models `files` as DOM `File[]`, which
// our forwarded-file subset intentionally does not match.
type _SlackMessageEventApiCrossCheck = [
  Expect<
    ModeledKeysAreOfficial<SlackMessageEvent, SlackApiGenericMessageEvent>
  >,
];

/**
 * Slack `block_actions` interactive payload (subset relevant to normalization),
 * delivered when a user clicks a Block Kit element (button, menu, …).
 *
 * No `@slack/types` cross-check here: unlike the Events API events, the
 * interaction payload has no published type in `@slack/types` (it models Block
 * Kit *elements*, e.g. `Button`, not the interaction envelope — that lives in
 * `@slack/bolt`). The tolerant schema is the sole validator.
 */
export const slackBlockActionsPayloadSchema = z.object({
  type: optionalString(),
  trigger_id: optionalString(),
  user: z
    .object({
      id: optionalString(),
      username: optionalString(),
      name: optionalString(),
    })
    .optional()
    .catch(undefined),
  channel: z
    .object({ id: optionalString(), name: optionalString() })
    .optional()
    .catch(undefined),
  message: z
    .object({
      ts: optionalString(),
      thread_ts: optionalString(),
      text: optionalString(),
    })
    .optional()
    .catch(undefined),
  actions: z
    .array(
      z.object({
        action_id: optionalString(),
        value: optionalString(),
        type: optionalString(),
        block_id: optionalString(),
        action_ts: optionalString(),
      }),
    )
    .optional()
    .catch(undefined),
});
export type SlackBlockActionsPayload = z.infer<
  typeof slackBlockActionsPayloadSchema
>;

/**
 * Slack `reaction_added` / `reaction_removed` event. Both carry an identical
 * payload, differentiated only by the `type` discriminator (the caller passes
 * the add-vs-remove distinction as an explicit `op`).
 */
export const slackReactionEventSchema = z.object({
  type: optionalString(),
  user: optionalString(),
  reaction: optionalString(),
  item: z
    .object({
      type: optionalString(),
      channel: optionalString(),
      ts: optionalString(),
    })
    .optional()
    .catch(undefined),
  item_user: optionalString(),
  event_ts: optionalString(),
});
/**
 * Slack `reaction_added` / `reaction_removed` share this one payload shape;
 * the add-vs-remove distinction is the runtime `type` discriminator (and the
 * explicit `op` the caller passes), not the type.
 */
export type SlackReactionEvent = z.infer<typeof slackReactionEventSchema>;

// Compile-time cross-check against the official Slack event types, via the
// shared `webhook-crosscheck` helpers. `@slack/types` is a types-only
// dependency: the `import type` above is erased from the build, so
// `slackReactionEventSchema` stays the sole runtime validator. `tsc` proves our
// tolerant schema never contradicts Slack's published shape, so a field rename
// or wrong primitive fails the build instead of silently parsing a live event
// to `undefined`.
type _SlackReactionApiCrossChecks = [
  Expect<
    ModeledKeysAreOfficial<SlackReactionEvent, SlackApiReactionAddedEvent>
  >,
  Expect<
    OfficialValueSatisfiesOurs<SlackReactionEvent, SlackApiReactionAddedEvent>
  >,
  Expect<
    ModeledKeysAreOfficial<SlackReactionEvent, SlackApiReactionRemovedEvent>
  >,
  Expect<
    OfficialValueSatisfiesOurs<SlackReactionEvent, SlackApiReactionRemovedEvent>
  >,
];

/**
 * Descriptor for a bot/app sender, derived from the message's `bot_id` /
 * `bot_profile` and the resolved user profile's `is_bot` flag. Present on a
 * normalized event only when the sender is a bot.
 */
export interface SlackBotSenderInfo {
  botId?: string;
  botName?: string;
  appId?: string;
  teamId?: string;
}

export type NormalizedSlackEvent = {
  event: GatewayInboundEvent;
  routing: RouteResult;
  /** Thread timestamp for reply threading. */
  threadTs?: string;
  /** Slack channel ID. */
  channel: string;
  /** Original Slack file objects keyed by file ID, for download in the I/O layer. */
  slackFiles?: Map<string, SlackFile>;
  /** Present when the sender is a bot/app rather than a person. */
  botSender?: SlackBotSenderInfo;
};
