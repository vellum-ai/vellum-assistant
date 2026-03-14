/**
 * Edit message intercept stage: handles inbound edited_message events by
 * updating the original message content in-place. No new agent loop is
 * triggered for edits.
 *
 * The retry-with-backoff lookup accounts for race conditions where the edit
 * webhook arrives before the original message has been linked via
 * linkMessage (the original agent loop may still be in progress).
 *
 * Extracted from inbound-message-handler.ts to keep the top-level handler
 * focused on orchestration.
 */
import type { ChannelId } from "../../../channels/types.js";
import { touchContactInteraction } from "../../../contacts/contacts-write.js";
import { updateMessageContent } from "../../../memory/conversation-crud.js";
import * as deliveryCrud from "../../../memory/delivery-crud.js";
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
    updateMessageContent(original.messageId, content ?? "");
    log.info(
      { assistantId, sourceMessageId, messageId: original.messageId },
      "Updated message content from edited_message",
    );
  } else {
    log.warn(
      { assistantId, sourceChannel, conversationExternalId, sourceMessageId },
      "Could not find original message for edit after retries, ignoring",
    );
  }

  return Response.json({
    accepted: true,
    duplicate: false,
    eventId: editResult.eventId,
  });
}
