/**
 * Tolerant Zod schemas for Telegram webhook payloads, and the compile-time
 * cross-check that keeps them honest against the official Bot API types.
 */

import { z } from "zod";

import type {
  Audio,
  CallbackQuery,
  Chat,
  Document as TelegramApiDocument,
  Message,
  MessageEntity,
  PhotoSize,
  Update,
  User,
  Voice,
} from "@grammyjs/types";

import type {
  Expect,
  ModeledKeysAreOfficial,
  OfficialValueSatisfiesOurs,
} from "../webhook-crosscheck.js";

// Telegram webhook payloads are untrusted external input (Telegram Bot API).
// These schemas validate the *types* of the nested fields the normalizer reads
// while staying tolerant: a malformed field collapses to `undefined` (or an
// empty string for required ids) rather than rejecting the whole update, so the
// downstream null-checks drop an unsupported message instead of forwarding a
// malformed value. Unknown keys are stripped from the parsed working copy; the
// original payload is preserved verbatim as `raw`.
const optionalNumber = () => z.number().optional().catch(undefined);
const optionalString = () => z.string().optional().catch(undefined);
const optionalBoolean = () => z.boolean().optional().catch(undefined);
/** A required id string: a missing/non-string value collapses to `""`. */
const idString = () => z.string().catch("");

const TelegramPhotoSizeSchema = z.object({
  file_id: idString(),
  file_unique_id: optionalString(),
  width: optionalNumber(),
  height: optionalNumber(),
  file_size: optionalNumber(),
});

const TelegramDocumentSchema = z.object({
  file_id: idString(),
  file_unique_id: optionalString(),
  file_name: optionalString(),
  mime_type: optionalString(),
  file_size: optionalNumber(),
});

const TelegramVoiceSchema = z.object({
  file_id: idString(),
  file_unique_id: optionalString(),
  duration: optionalNumber(),
  mime_type: optionalString(),
  file_size: optionalNumber(),
});

const TelegramAudioSchema = z.object({
  file_id: idString(),
  file_unique_id: optionalString(),
  duration: optionalNumber(),
  performer: optionalString(),
  title: optionalString(),
  file_name: optionalString(),
  mime_type: optionalString(),
  file_size: optionalNumber(),
});

const TelegramFromSchema = z
  .object({
    id: optionalNumber(),
    is_bot: optionalBoolean(),
    username: optionalString(),
    first_name: optionalString(),
    last_name: optionalString(),
    language_code: optionalString(),
  })
  .optional()
  .catch(undefined);

/**
 * One special span of a message's text. Only the kinds the admission gate
 * reads are modeled: `mention` and `bot_command` name the bot by username in
 * the text itself, `text_mention` names it by user id.
 */
const TelegramMessageEntitySchema = z.object({
  type: optionalString(),
  offset: optionalNumber(),
  length: optionalNumber(),
  user: z.object({ id: optionalNumber() }).optional().catch(undefined),
});
export type TelegramMessageEntity = z.infer<typeof TelegramMessageEntitySchema>;

/**
 * The message this one replies to. Telegram never nests a reply inside a
 * reply, so only the author is modeled: a reply to the bot's own post is one
 * of the ways a room message addresses it.
 */
const TelegramReplyToMessageSchema = z
  .object({ message_id: optionalNumber(), from: TelegramFromSchema })
  .optional()
  .catch(undefined);

const TelegramMessageSchema = z.object({
  message_id: optionalNumber(),
  message_thread_id: optionalNumber(),
  is_topic_message: optionalBoolean(),
  text: optionalString(),
  caption: optionalString(),
  entities: z.array(TelegramMessageEntitySchema).optional().catch(undefined),
  caption_entities: z
    .array(TelegramMessageEntitySchema)
    .optional()
    .catch(undefined),
  reply_to_message: TelegramReplyToMessageSchema,
  chat: z
    .object({ id: optionalNumber(), type: optionalString() })
    .optional()
    .catch(undefined),
  from: TelegramFromSchema,
  photo: z.array(TelegramPhotoSizeSchema).optional().catch(undefined),
  document: TelegramDocumentSchema.optional().catch(undefined),
  voice: TelegramVoiceSchema.optional().catch(undefined),
  audio: TelegramAudioSchema.optional().catch(undefined),
});
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;

const TelegramCallbackQuerySchema = z.object({
  id: idString(),
  from: TelegramFromSchema,
  message: TelegramMessageSchema.optional().catch(undefined),
  data: optionalString(),
});

export const TelegramUpdateSchema = z.object({
  update_id: optionalNumber(),
  message: TelegramMessageSchema.optional().catch(undefined),
  edited_message: TelegramMessageSchema.optional().catch(undefined),
  callback_query: TelegramCallbackQuerySchema.optional().catch(undefined),
});

// ---------------------------------------------------------------------------
// Compile-time cross-check against the official Telegram Bot API types.
//
// `@grammyjs/types` is a types-only dev dependency: it contributes nothing at
// runtime (the `import type` above is erased from the build) and the schemas
// above stay the sole runtime validators. Its only job is to make TypeScript
// prove, via the shared `webhook-crosscheck` helpers, that a drift from the
// real Bot API shape fails `tsc` instead of silently mis-parsing a live
// webhook, e.g. a field-name typo like `messsage_thread_id` (which would
// otherwise always parse to `undefined`) or a wrong primitive (`chat.id` as a
// string).
type TelegramFrom = NonNullable<z.infer<typeof TelegramFromSchema>>;
type TelegramChat = NonNullable<TelegramMessage["chat"]>;
/** The official reply shape is not exported by name; it is what `Message` carries. */
type OfficialReplyMessage = NonNullable<Message["reply_to_message"]>;

type _TelegramApiCrossChecks = [
  // `user` exists only on the text_mention member of the entity union, so the
  // key check runs against that member and the value check against the union.
  Expect<
    ModeledKeysAreOfficial<
      TelegramMessageEntity,
      MessageEntity.TextMentionMessageEntity
    >
  >,
  Expect<OfficialValueSatisfiesOurs<TelegramMessageEntity, MessageEntity>>,
  Expect<
    ModeledKeysAreOfficial<
      NonNullable<TelegramMessage["reply_to_message"]>,
      OfficialReplyMessage
    >
  >,
  Expect<
    OfficialValueSatisfiesOurs<
      NonNullable<TelegramMessage["reply_to_message"]>,
      OfficialReplyMessage
    >
  >,
  Expect<ModeledKeysAreOfficial<z.infer<typeof TelegramUpdateSchema>, Update>>,
  Expect<
    OfficialValueSatisfiesOurs<z.infer<typeof TelegramUpdateSchema>, Update>
  >,
  Expect<ModeledKeysAreOfficial<TelegramMessage, Message>>,
  Expect<OfficialValueSatisfiesOurs<TelegramMessage, Message>>,
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof TelegramCallbackQuerySchema>,
      CallbackQuery
    >
  >,
  Expect<
    OfficialValueSatisfiesOurs<
      z.infer<typeof TelegramCallbackQuerySchema>,
      CallbackQuery
    >
  >,
  Expect<ModeledKeysAreOfficial<TelegramChat, Chat>>,
  Expect<ModeledKeysAreOfficial<TelegramFrom, User>>,
  Expect<
    ModeledKeysAreOfficial<z.infer<typeof TelegramPhotoSizeSchema>, PhotoSize>
  >,
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof TelegramDocumentSchema>,
      TelegramApiDocument
    >
  >,
  Expect<ModeledKeysAreOfficial<z.infer<typeof TelegramVoiceSchema>, Voice>>,
  Expect<ModeledKeysAreOfficial<z.infer<typeof TelegramAudioSchema>, Audio>>,
];
