import {
  type ChannelMessageMetadata,
  channelMessageMetadataSchema,
} from "./channel-message-metadata.js";
import {
  readSlackMetadataFromMessageMetadata,
  slackMetadataAsChannelMetadata,
} from "./providers/slack/message-metadata.js";

/**
 * Read a stored row's channel metadata in terms no single provider owns.
 *
 * Two ways a row can carry it, in this order.
 *
 * `channelMeta` is the neutral shape written directly. This is the path that
 * matters most: a channel we have no code for, a plugin channel above all,
 * can describe its own rows in it and every channel-agnostic reader
 * understands them. History assembly, the conversation route and the
 * transcript renderer then work for a channel nobody here has heard of.
 *
 * `slackMeta` is Slack's own envelope, mapped on read. Slack predates the
 * neutral shape and holds fields no other channel has an equivalent for, so
 * it keeps writing what it writes and loses nothing. That makes Slack the
 * exception rather than the pattern: a channel added from here writes
 * `channelMeta` and needs no adapter at all.
 *
 * Normalizing on read rather than on write is what allows both. Writing stays
 * where provider detail legitimately lives, nothing is rewritten, and nothing
 * is stored twice.
 *
 * A row with no recognized envelope, or one that fails validation, reads as
 * null: callers already treat absent metadata as "not a channel row".
 */
export function readChannelMetadata(
  metadata: string | null | undefined,
  opts?: { allowFlatLegacy?: boolean },
): ChannelMessageMetadata | null {
  if (!metadata) {
    return null;
  }

  let parent: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parent = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  const neutral = parent?.channelMeta;
  if (typeof neutral === "string") {
    try {
      const result = channelMessageMetadataSchema.safeParse(
        JSON.parse(neutral) as unknown,
      );
      if (result.success) {
        return result.data;
      }
    } catch {
      // Malformed neutral metadata falls through to the provider envelopes
      // below rather than failing the read outright.
    }
  }

  const slackMeta = readSlackMetadataFromMessageMetadata(metadata, opts);
  return slackMeta ? slackMetadataAsChannelMetadata(slackMeta) : null;
}
