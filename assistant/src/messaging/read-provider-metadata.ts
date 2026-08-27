import type { ChannelId } from "../channels/types.js";
import { safeParseRecord } from "../util/json.js";
import {
  type ProviderMessageMetadata,
  readProviderMessageMetadata,
} from "./provider-message-metadata.js";
import {
  readSlackMetadataFromMessageMetadata,
  slackMetadataAsProviderMetadata,
} from "./providers/slack/message-metadata.js";

/**
 * Read a stored row's channel metadata in terms no single provider owns.
 *
 * Two ways a row can carry it, in this order.
 *
 * `providerMeta` is the neutral shape written directly. This is the path that
 * matters most: a channel we have no code for, a plugin channel above all,
 * can describe its own rows in it and every channel-agnostic reader
 * understands them. History assembly, the conversation route and the
 * transcript renderer then work for a channel nobody here has heard of.
 *
 * `slackMeta` is Slack's own envelope, mapped on read. It holds fields no
 * other channel has an equivalent for, so Slack keeps writing it and loses
 * nothing. A channel that writes `providerMeta` needs no adapter at all.
 *
 * Normalizing on read is what allows both. Writing stays where provider
 * detail legitimately lives, and nothing is stored twice.
 *
 * A row with no recognized envelope, or one that fails validation, reads as
 * null: callers already treat absent metadata as "not a channel row".
 */
export function readProviderMetadata(
  metadata: string | null | undefined,
  opts?: { allowFlatLegacy?: boolean },
): ProviderMessageMetadata | null {
  if (!metadata) {
    return null;
  }

  // Malformed neutral metadata falls through to the provider envelopes rather
  // than failing the read outright.
  const neutral = readProviderMessageMetadata(
    safeParseRecord(metadata).providerMeta,
  );
  if (neutral) {
    return neutral;
  }

  const slackMeta = readSlackMetadataFromMessageMetadata(metadata, opts);
  return slackMeta ? slackMetadataAsProviderMetadata(slackMeta) : null;
}

/**
 * Merge an edit or delete stamp into a row's serialized metadata, producing
 * the neutral envelope to store back under `providerMeta`.
 *
 * The base is whatever the row already says about itself through
 * {@link readProviderMetadata}, flat-legacy Slack rows included, so fields
 * the old envelope carried (thread, actor, display name) survive the stamp
 * rather than being shadowed by a minimal synthesis. A row that says
 * nothing gets the envelope synthesized from the caller's lookup-derived
 * facts, so the result always validates on read.
 */
export function mergeProviderMessageMetadata(
  rowMetadata: string | null,
  seed: {
    source: ChannelId;
    conversationExternalId: string;
    messageId: string;
    threadId?: string;
  },
  patch: { editedAt?: number; deletedAt?: number },
): string {
  const base = readProviderMetadata(rowMetadata, { allowFlatLegacy: true }) ?? {
    source: seed.source,
    conversationExternalId: seed.conversationExternalId,
    messageId: seed.messageId,
    ...(seed.threadId ? { threadId: seed.threadId } : {}),
    eventKind: "message" as const,
  };
  return JSON.stringify({ ...base, ...patch });
}
