/**
 * Durable conversation handles: the external provider conversation a Vellum
 * conversation is bound to, in a serializable, schema-validated form.
 *
 * A handle answers "which provider conversation, reached through which Vellum
 * channel connection". The same handle is usable for inbound conversation
 * binding and for later outbound delivery, so it carries exactly two things:
 * the connection identity needed to recover the correct provider credentials,
 * and the provider-native routing coordinates. Message coordinates (message
 * ids, reply-to relationships), actors, and content are per-event data and are
 * deliberately not part of the handle.
 *
 * The handle names the provider-side conversation only. Vellum's internal
 * `conversationId` is a separate identity and never appears inside a handle;
 * the binding between the two lives wherever handles are persisted.
 *
 * Every variant is a strict object, so a field from another provider, a
 * flattened `threadId`/`topicId`, or a smuggled message id fails validation
 * instead of riding along untyped.
 */

import { z } from "zod";

import type { ChannelId } from "./channels.js";

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

/** Upper bound on any single handle field. */
const MAX_FIELD_LENGTH = 256;

/**
 * The Vellum channel connection (installation) the conversation belongs to.
 * Opaque to this contract: it identifies which stored provider credentials
 * and provider account reach the conversation, not any provider object.
 */
const connectionId = () =>
  z
    .string()
    .min(1)
    .max(MAX_FIELD_LENGTH)
    .regex(
      /^[^\s\p{Cc}]+$/u,
      "must not contain whitespace or control characters",
    );

/** A Telegram Bot API integer id as decimal digits (int64 width). */
const telegramId = () =>
  z.string().regex(/^\d{1,19}$/, "must be decimal digits");

/** Bot API `chat.id`: negative for groups, supergroups, and channels. */
const telegramChatId = () =>
  z
    .string()
    .regex(/^-?\d{1,19}$/, "must be decimal digits, optionally negative");

const slackTeamId = () =>
  z
    .string()
    .max(MAX_FIELD_LENGTH)
    .regex(/^T[A-Z0-9]{2,}$/, "must be a Slack workspace id, e.g. T0123ABCD");

/** `C…` public channel, `D…` DM, `G…` private channel or legacy group DM. */
const slackChannelId = () =>
  z
    .string()
    .max(MAX_FIELD_LENGTH)
    .regex(
      /^[CDG][A-Z0-9]{2,}$/,
      "must be a Slack conversation id, e.g. C0123ABCD",
    );

/** A Slack message timestamp, the thread key (`thread_ts`). */
const slackThreadTs = () =>
  z
    .string()
    .regex(
      /^\d{10}\.\d{6}$/,
      "must be a Slack message timestamp, e.g. 1700000000.000100",
    );

/** A Discord snowflake as decimal digits. */
const discordSnowflake = () =>
  z.string().regex(/^\d{1,20}$/, "must be a Discord snowflake");

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

/**
 * Where inside a Telegram chat the conversation lives. `message_thread`
 * carries a Bot API `message_thread_id` (forum topics and private-chat topic
 * mode); `direct_messages_topic` carries a `direct_messages_topic_id`
 * (channel direct-messages monoforums). They are different Bot API routing
 * fields, so they are distinct variants rather than one untyped topic id, and
 * the union makes a mixed shape unrepresentable.
 */
export const TelegramSubconversationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("chat") }),
  z.strictObject({ kind: z.literal("message_thread"), id: telegramId() }),
  z.strictObject({
    kind: z.literal("direct_messages_topic"),
    id: telegramId(),
  }),
]);

export type TelegramSubconversation = z.infer<
  typeof TelegramSubconversationSchema
>;

export const TelegramConversationHandleSchema = z.strictObject({
  provider: z.literal("telegram"),
  connectionId: connectionId(),
  /** Bot API `chat.id`. Negative for groups, supergroups, and channels. */
  chatId: telegramChatId(),
  subconversation: TelegramSubconversationSchema,
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

/**
 * Slack routing keeps its native shape: conversation ids are unique only
 * within a workspace, and a thread is keyed by the parent message's
 * `thread_ts`. `threadTs` absent means the conversation is the channel
 * itself, not that the producer may omit it.
 */
export const SlackConversationHandleSchema = z.strictObject({
  provider: z.literal("slack"),
  connectionId: connectionId(),
  /** Workspace id (`T…`). */
  teamId: slackTeamId(),
  /** Conversation id: `C…` channel, `D…` DM, `G…` private or group DM. */
  channelId: slackChannelId(),
  /** `thread_ts` of the thread parent, on a threaded conversation only. */
  threadTs: slackThreadTs().optional(),
});

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

/**
 * Discord routing keeps its native shape: a thread is itself a channel
 * snowflake under a parent channel, and the adapter admits guild messages
 * only, so the guild is always part of the handle.
 */
export const DiscordConversationHandleSchema = z.strictObject({
  provider: z.literal("discord"),
  connectionId: connectionId(),
  /** Guild (server) snowflake. */
  guildId: discordSnowflake(),
  /** Parent channel snowflake, the conversation itself outside a thread. */
  channelId: discordSnowflake(),
  /** Thread or forum-post snowflake, on a thread conversation only. */
  threadId: discordSnowflake().optional(),
});

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

/**
 * Providers that have a durable handle shape. Every entry must be a canonical
 * `ChannelId`; the `satisfies` clause enforces that at compile time.
 */
export const CONVERSATION_HANDLE_PROVIDERS = [
  "discord",
  "slack",
  "telegram",
] as const satisfies readonly ChannelId[];

export type ConversationHandleProvider =
  (typeof CONVERSATION_HANDLE_PROVIDERS)[number];

/**
 * Handle variant per provider. The `satisfies Record<…>` annotation is the
 * exhaustiveness gate: adding a provider to `CONVERSATION_HANDLE_PROVIDERS`
 * fails to compile until its handle shape is spelled out here.
 */
export const CONVERSATION_HANDLE_SCHEMAS = {
  discord: DiscordConversationHandleSchema,
  slack: SlackConversationHandleSchema,
  telegram: TelegramConversationHandleSchema,
} as const satisfies Record<ConversationHandleProvider, z.ZodObject>;

export const ConversationHandleSchema = z.discriminatedUnion("provider", [
  CONVERSATION_HANDLE_SCHEMAS.discord,
  CONVERSATION_HANDLE_SCHEMAS.slack,
  CONVERSATION_HANDLE_SCHEMAS.telegram,
]);

export type ConversationHandle = z.infer<typeof ConversationHandleSchema>;

/** The handle variant for one provider, e.g. `ConversationHandleFor<"slack">`. */
export type ConversationHandleFor<P extends ConversationHandleProvider> =
  Extract<ConversationHandle, { provider: P }>;

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a handle to its JSON wire form. The handle is validated first, so
 * the output is always the serialization of a valid handle.
 *
 * @throws {z.ZodError} when the value is not a valid {@link ConversationHandle}.
 */
export function serializeConversationHandle(
  handle: ConversationHandle,
): string {
  return JSON.stringify(ConversationHandleSchema.parse(handle));
}

/**
 * Inverse of {@link serializeConversationHandle}. Returns `null` for anything
 * that is not the JSON serialization of a valid handle: malformed JSON, an
 * unknown provider, a missing or malformed coordinate, or a field the
 * provider's shape does not declare.
 */
export function safeDeserializeConversationHandle(
  text: string,
): ConversationHandle | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const result = ConversationHandleSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Inverse of {@link serializeConversationHandle}, throwing instead of
 * returning `null`.
 */
export function deserializeConversationHandle(text: string): ConversationHandle {
  const handle = safeDeserializeConversationHandle(text);
  if (handle === null) {
    throw new Error("not a valid conversation handle serialization");
  }
  return handle;
}
