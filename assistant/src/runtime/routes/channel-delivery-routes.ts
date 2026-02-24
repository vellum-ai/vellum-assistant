/**
 * Channel delivery routes: delivery ack, dead letters, reply delivery,
 * and post-decision delivery scheduling.
 */
import * as conversationStore from '../../memory/conversation-store.js';
import * as attachmentsStore from '../../memory/attachments-store.js';
import * as channelDeliveryStore from '../../memory/channel-delivery-store.js';
import { renderHistoryContent } from '../../daemon/handlers.js';
import { getLogger } from '../../util/logger.js';
import { deliverChannelReply } from '../gateway-client.js';
import type { RuntimeAttachmentMetadata } from '../http-types.js';
import type { RunOrchestrator } from '../run-orchestrator.js';
import { POST_DECISION_POLL_INTERVAL_MS, POST_DECISION_POLL_MAX_WAIT_MS } from './channel-route-shared.js';

const log = getLogger('runtime-http');

// ---------------------------------------------------------------------------
// Dead letter management
// ---------------------------------------------------------------------------

export function handleListDeadLetters(): Response {
  const events = channelDeliveryStore.getDeadLetterEvents();
  return Response.json({ events });
}

export async function handleReplayDeadLetters(req: Request): Promise<Response> {
  const body = await req.json() as { eventIds?: string[] };
  const eventIds = body.eventIds;

  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return Response.json({ error: 'eventIds array is required' }, { status: 400 });
  }

  const replayed = channelDeliveryStore.replayDeadLetters(eventIds);
  return Response.json({ replayed });
}

// ---------------------------------------------------------------------------
// Delivery acknowledgement
// ---------------------------------------------------------------------------

export async function handleChannelDeliveryAck(req: Request): Promise<Response> {
  const body = await req.json() as {
    sourceChannel?: string;
    externalChatId?: string;
    externalMessageId?: string;
  };

  const { sourceChannel, externalChatId, externalMessageId } = body;

  if (!sourceChannel || typeof sourceChannel !== 'string') {
    return Response.json({ error: 'sourceChannel is required' }, { status: 400 });
  }
  if (!externalChatId || typeof externalChatId !== 'string') {
    return Response.json({ error: 'externalChatId is required' }, { status: 400 });
  }
  if (!externalMessageId || typeof externalMessageId !== 'string') {
    return Response.json({ error: 'externalMessageId is required' }, { status: 400 });
  }

  const acked = channelDeliveryStore.acknowledgeDelivery(
    sourceChannel,
    externalChatId,
    externalMessageId,
  );

  if (!acked) {
    return Response.json({ error: 'Inbound event not found' }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Reply delivery via callback
// ---------------------------------------------------------------------------

export async function deliverReplyViaCallback(
  conversationId: string,
  externalChatId: string,
  callbackUrl: string,
  bearerToken?: string,
  assistantId?: string,
): Promise<void> {
  const msgs = conversationStore.getMessages(conversationId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      let parsed: unknown;
      try { parsed = JSON.parse(msgs[i].content); } catch { parsed = msgs[i].content; }
      const rendered = renderHistoryContent(parsed);

      const linked = attachmentsStore.getAttachmentMetadataForMessage(msgs[i].id);
      const replyAttachments: RuntimeAttachmentMetadata[] = linked.map((a) => ({
        id: a.id,
        filename: a.originalFilename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        kind: a.kind,
      }));

      if (rendered.text || replyAttachments.length > 0) {
        await deliverChannelReply(callbackUrl, {
          chatId: externalChatId,
          text: rendered.text || undefined,
          attachments: replyAttachments.length > 0 ? replyAttachments : undefined,
          assistantId,
        }, bearerToken);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Post-decision delivery scheduling
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: after a decision is applied via `handleApprovalInterception`,
 * poll the run briefly for terminal state and deliver the final reply. This
 * handles the case where the original poll in `processChannelMessageWithApprovals`
 * has already exited due to the 5-minute timeout.
 *
 * Uses the same `claimRunDelivery` guard as the main poll to guarantee
 * at-most-once delivery: whichever poller reaches terminal state first
 * claims the delivery, and the other silently skips it.
 */
export function schedulePostDecisionDelivery(
  orchestrator: RunOrchestrator,
  runId: string,
  conversationId: string,
  externalChatId: string,
  replyCallbackUrl: string,
  bearerToken?: string,
  assistantId?: string,
): void {
  (async () => {
    try {
      const startTime = Date.now();
      while (Date.now() - startTime < POST_DECISION_POLL_MAX_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, POST_DECISION_POLL_INTERVAL_MS));
        const current = orchestrator.getRun(runId);
        if (!current) break;
        if (current.status === 'completed' || current.status === 'failed') {
          if (channelDeliveryStore.claimRunDelivery(runId)) {
            try {
              await deliverReplyViaCallback(
                conversationId,
                externalChatId,
                replyCallbackUrl,
                bearerToken,
                assistantId,
              );
            } catch (deliveryErr) {
              channelDeliveryStore.resetRunDeliveryClaim(runId);
              throw deliveryErr;
            }
          }
          return;
        }
      }
      log.warn(
        { runId, conversationId },
        'Post-decision delivery poll timed out without run reaching terminal state',
      );
    } catch (err) {
      log.error({ err, runId, conversationId }, 'Post-decision delivery failed');
    }
  })();
}
