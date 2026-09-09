/**
 * Post-send reconciliation of an outbound assistant row.
 *
 * A row the daemon authors for a channel post is written before the channel
 * has it, so its envelope names no provider message id. Once the transport
 * reports the id the channel assigned, this module records it in two places
 * with one writer: the `channel_outbound_posts` index, which is the
 * resolution contract a later reaction or delete naming the post resolves
 * through, and the row's own `providerMeta` envelope, which stays the row's
 * self-description. The two cannot drift because nothing else writes either.
 *
 * Callable outside a turn: the reply path composes it into its delivery
 * callback, and any other producer that persists a row and then delivers it
 * through a channel adapter reconciles the acknowledged id the same way.
 */

import type { ProviderMessageMetadata } from "../messaging/provider-message-metadata.js";
import {
  everyPostDeleted,
  readProviderMessageMetadata,
} from "../messaging/provider-message-metadata.js";
import { providerMetadataOfPreSendSlackEnvelope } from "../messaging/providers/slack/message-metadata.js";
import {
  getMessageById,
  updateMessageMetadata,
} from "../persistence/conversation-crud.js";
import { recordOutboundPost } from "../persistence/delivery-crud.js";
import { safeParseRecord } from "../util/json.js";
import { getLogger } from "../util/logger.js";
import { withSqliteRetry } from "../util/sqlite-retry.js";

const log = getLogger("outbound-post-reconciliation");

/**
 * Build a handler that reconciles the persisted assistant row's provider
 * message ids from the transport's authoritative ones. Every channel's
 * outbound row carries the neutral envelope (`readReplyEnvelope` names the
 * one pending row that may not yet), so there is one rule: the first
 * reported id becomes `providerMeta.messageId`, the further posts of a reply
 * split at tool boundaries or length limits accumulate under
 * `additionalMessageIds`, and every id lands in the `channel_outbound_posts`
 * index, which is what lets a later reaction or delete naming any of the
 * assistant's posts resolve back to this row.
 *
 * An id the row already names is a redelivery and is skipped. A row
 * persisted with no envelope (e.g. vellum outbound) is left untouched. Every
 * write retries transient SQLite contention (`withSqliteRetry`), because
 * this is the only durable record of the sent message's id and nothing
 * revisits it once the delivery settles. Remaining failures are logged and
 * swallowed so a DB error cannot break the outbound delivery itself.
 */
export function makeSentMessageIdReconciler(
  messageId: string,
): (ts: string) => Promise<void> {
  return async (ts: string): Promise<void> => {
    if (!ts) {
      return;
    }
    try {
      const row = getMessageById(messageId);
      if (row === null || row.metadata === null) {
        return;
      }
      const providerMeta = readReplyEnvelope(safeParseRecord(row.metadata));
      if (
        providerMeta === null ||
        providerIdPatchFor(providerMeta, ts) === null
      ) {
        return;
      }
      // The index first: it is the resolution contract, and the insert is
      // conflict-ignoring, so a redelivered id is a no-op there too.
      await withSqliteRetry(
        () =>
          recordOutboundPost({
            sourceChannel: providerMeta.source,
            externalChatId: providerMeta.conversationExternalId,
            providerMessageId: ts,
            messageId,
            conversationId: row.conversationId,
          }),
        { op: "record_outbound_post", context: { messageId } },
      );
      // The envelope is read and written in one synchronous step, re-read on
      // every attempt, and the delete stage stamps its rows the same way, so
      // neither overwrites the other's patch: bun:sqlite is synchronous and
      // nothing yields between the read and the write.
      await withSqliteRetry(() => stampSentMessageId(messageId, ts), {
        op: "reconcile_sent_message_id",
        context: { messageId },
      });
    } catch (err) {
      log.warn(
        { err, messageId },
        "Failed to reconcile the sent message id on the outbound assistant row",
      );
    }
  };
}

/**
 * Record a reported id on the row's envelope. A post just reported is on the
 * channel, so the row-level deletion marker is recomputed: it stays only
 * when every post the row now names, this one included, is already recorded
 * as deleted (a deletion can land between the index write and this stamp,
 * and it can name this very post); a marker left by an earlier state in
 * which every known post was gone is cleared. Synchronous by design; see
 * the caller.
 */
function stampSentMessageId(messageId: string, ts: string): void {
  const row = getMessageById(messageId);
  if (row === null || row.metadata === null) {
    return;
  }
  const envelope = safeParseRecord(row.metadata);
  const providerMeta = readReplyEnvelope(envelope);
  if (providerMeta === null) {
    return;
  }
  const patch = providerIdPatchFor(providerMeta, ts);
  if (patch === null) {
    return;
  }
  const posts = [
    ...(providerMeta.messageId !== undefined ? [providerMeta.messageId] : []),
    ...(providerMeta.additionalMessageIds ?? []),
    ts,
  ];
  const { deletedAt, ...rest } = providerMeta;
  updateMessageMetadata(messageId, {
    providerMeta: JSON.stringify({
      ...rest,
      ...patch,
      ...(deletedAt !== undefined &&
      everyPostDeleted(posts, providerMeta.deletedMessageIds)
        ? { deletedAt }
        : {}),
    }),
    // A row reserved with Slack's pre-send envelope converges on the neutral
    // one here: `updateMessageMetadata` serializes the merged envelope with
    // `JSON.stringify`, which drops a key set to undefined.
    ...(envelope.slackMeta !== undefined ? { slackMeta: undefined } : {}),
  });
}

/**
 * The envelope an outbound row stamps its sent ids onto: the neutral one
 * every row the daemon reserves carries, or, for a reply still pending from
 * a daemon that reserved Slack replies under Slack's own envelope, the
 * neutral reading of that pre-send envelope (transitional; see
 * `providerMetadataOfPreSendSlackEnvelope`).
 */
function readReplyEnvelope(
  envelope: Record<string, unknown>,
): ProviderMessageMetadata | null {
  return (
    readProviderMessageMetadata(envelope.providerMeta) ??
    providerMetadataOfPreSendSlackEnvelope(envelope)
  );
}

/**
 * Where a newly reported id belongs on the neutral envelope: `messageId` when
 * the row names none yet, otherwise appended to `additionalMessageIds`.
 * `null` when the envelope already names it, which is a redelivery.
 */
function providerIdPatchFor(
  providerMeta: ProviderMessageMetadata,
  ts: string,
): Partial<ProviderMessageMetadata> | null {
  if (providerMeta.messageId === undefined) {
    return { messageId: ts };
  }
  if (
    providerMeta.messageId === ts ||
    providerMeta.additionalMessageIds?.includes(ts)
  ) {
    return null;
  }
  return {
    additionalMessageIds: [...(providerMeta.additionalMessageIds ?? []), ts],
  };
}
