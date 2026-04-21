/**
 * Edit message intercept stage: handles inbound edited_message events by
 * updating the original message content in-place. No new agent loop is
 * triggered for edits.
 *
 * The retry-with-backoff lookup accounts for race conditions where the edit
 * webhook arrives before the original message has been linked via
 * linkMessage (the original agent loop may still be in progress).
 *
 * For Slack edits, the stage additionally stamps `slackMeta.editedAt` into
 * the message's metadata via a single transactional content+metadata update,
 * so downstream renderers can surface the edited marker.
 *
 * Extracted from inbound-message-handler.ts to keep the top-level handler
 * focused on orchestration.
 */
import type { ChannelId } from "../../../channels/types.js";
import { touchContactInteraction } from "../../../contacts/contacts-write.js";
import {
  getMessageById,
  updateMessageContent,
  updateMessageContentAndMetadata,
} from "../../../memory/conversation-crud.js";
import * as deliveryCrud from "../../../memory/delivery-crud.js";
import {
  mergeSlackMetadata,
  readSlackMetadata,
} from "../../../messaging/providers/slack/message-metadata.js";
import { safeParseRecord } from "../../../util/json.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("runtime-http");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EditInterceptParams {
  sourceChannel: ChannelId;
  conversationExternalId: string;
  externalMessageId: string;
  sourceMessageId: string;
  canonicalAssistantId: string;
  assistantId: string;
  content: string | undefined;
  /** Channel ID for channel-level interaction tracking. */
  channelId?: string;
}

/**
 * Handle an inbound edit event by deduplicating and updating the original
 * message content.
 *
 * Returns a Response on success (the pipeline should short-circuit), or
 * null if this stage does not apply.
 */
export async function handleEditIntercept(
  params: EditInterceptParams,
): Promise<Response> {
  const {
    sourceChannel,
    conversationExternalId,
    externalMessageId,
    sourceMessageId,
    canonicalAssistantId,
    assistantId,
    content,
    channelId,
  } = params;

  // Dedup the edit event itself (retried edited_message webhooks)
  const editResult = deliveryCrud.recordInbound(
    sourceChannel,
    conversationExternalId,
    externalMessageId,
    { sourceMessageId, assistantId: canonicalAssistantId },
  );

  if (editResult.duplicate) {
    return Response.json({
      accepted: true,
      duplicate: true,
      eventId: editResult.eventId,
    });
  }

  // Track contact interaction only for genuinely new edit events (not webhook
  // retries), matching the pattern used for the normal message path.
  if (channelId) {
    touchContactInteraction(channelId);
  }

  // Retry lookup a few times -- the original message may still be processing
  // (linkMessage hasn't been called yet). Short backoff avoids losing edits
  // that arrive while the original agent loop is in progress.
  const EDIT_LOOKUP_RETRIES = 5;
  const EDIT_LOOKUP_DELAY_MS = 2000;

  let original: { messageId: string; conversationId: string } | null = null;
  for (let attempt = 0; attempt <= EDIT_LOOKUP_RETRIES; attempt++) {
    original = deliveryCrud.findMessageBySourceId(
      sourceChannel,
      conversationExternalId,
      sourceMessageId,
    );
    if (original) break;
    if (attempt < EDIT_LOOKUP_RETRIES) {
      log.info(
        {
          assistantId,
          sourceMessageId,
          attempt: attempt + 1,
          maxAttempts: EDIT_LOOKUP_RETRIES,
        },
        "Original message not linked yet, retrying edit lookup",
      );
      await new Promise((resolve) => setTimeout(resolve, EDIT_LOOKUP_DELAY_MS));
    }
  }

  if (original) {
    const newContent = content ?? "";
    // Short-circuit no-op edits: Slack fires `message_changed` for link
    // unfurls and other decorations where the text is identical to the
    // previous revision. Skipping the DB write here covers that case and
    // also drops trivially-redundant edit webhooks. We only have the
    // authoritative previous text once the original row is located, so
    // this check lives after the lookup.
    const existingRow = getMessageById(original.messageId);
    if (existingRow && existingRow.content === newContent) {
      log.debug(
        {
          assistantId,
          sourceChannel,
          sourceMessageId,
          messageId: original.messageId,
        },
        "Edit text unchanged; skipping update",
      );
      return Response.json({
        accepted: true,
        duplicate: false,
        noop: true,
        eventId: editResult.eventId,
      });
    }
    if (sourceChannel === "slack") {
      // Slack edits stamp `slackMeta.editedAt` so the chronological
      // transcript renderer can surface the edited marker. The merge
      // tolerates rows that lack slackMeta enrichment by synthesizing
      // the minimum-required fields from the lookup data.
      applySlackEditMetadata({
        messageId: original.messageId,
        conversationExternalId,
        sourceMessageId,
        newContent,
      });
    } else {
      updateMessageContent(original.messageId, newContent);
    }
    log.info(
      { assistantId, sourceMessageId, messageId: original.messageId },
      "Updated message content from edited_message",
    );
  } else {
    // For Slack, treat missing-target edits as `debug` (the row may have
    // been compacted, never stored, or pre-date this upgrade); for other
    // channels, retain the louder `warn` since their edit pipelines
    // historically expect the row to exist.
    if (sourceChannel === "slack") {
      log.debug(
        {
          assistantId,
          sourceChannel,
          channelId: conversationExternalId,
          externalMessageId: sourceMessageId,
        },
        "Slack edit target not found, ignoring",
      );
    } else {
      log.warn(
        { assistantId, sourceChannel, conversationExternalId, sourceMessageId },
        "Could not find original message for edit after retries, ignoring",
      );
    }
  }

  return Response.json({
    accepted: true,
    duplicate: false,
    eventId: editResult.eventId,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Apply a Slack edit to the stored message: update content and stamp
 * `slackMeta.editedAt` in the same transaction.
 *
 * If the row already has a valid `slackMeta` sub-object, the merge preserves
 * all existing fields and only sets/refreshes `editedAt`. If the row lacks
 * `slackMeta` enrichment, the helper synthesizes the minimum-required fields
 * (`source`, `channelId`, `channelTs`, `eventKind`) from the values that
 * brought us here so the resulting metadata is still readable by
 * `readSlackMetadata`.
 */
function applySlackEditMetadata(params: {
  messageId: string;
  conversationExternalId: string;
  sourceMessageId: string;
  newContent: string;
}): void {
  const { messageId, conversationExternalId, sourceMessageId, newContent } =
    params;

  const row = getMessageById(messageId);
  const outerMetadata: Record<string, unknown> =
    row?.metadata != null ? safeParseRecord(row.metadata) : {};
  const existingSlackMeta =
    typeof outerMetadata.slackMeta === "string"
      ? outerMetadata.slackMeta
      : undefined;

  const editedAt = Date.now();
  const parsedExisting = readSlackMetadata(existingSlackMeta ?? null);

  // When the row has no valid existing slackMeta, `mergeSlackMetadata`
  // would produce a record missing the required fields and fail subsequent
  // `readSlackMetadata` calls. Seed defaults from the lookup-derived facts
  // so the post-merge value is always a valid `SlackMessageMetadata`.
  const mergedSlackMeta = mergeSlackMetadata(existingSlackMeta ?? null, {
    ...(parsedExisting
      ? {}
      : {
          source: "slack" as const,
          channelId: conversationExternalId,
          channelTs: sourceMessageId,
          eventKind: "message" as const,
        }),
    editedAt,
  });

  updateMessageContentAndMetadata(messageId, newContent, {
    slackMeta: mergedSlackMeta,
  });
}
