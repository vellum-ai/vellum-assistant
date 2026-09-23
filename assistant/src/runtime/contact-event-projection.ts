/**
 * Projection from an assistant event to what a trusted contact's event stream
 * may carry.
 *
 * The projection is an allowlist over event types: an event reaches a contact
 * only when its type is handled below, so reasoning and text deltas, tool
 * traffic, prompts meant for the guardian, and any event type added later are
 * dropped until they are explicitly allowed. Each allowed event is rebuilt
 * from its known fields, so fields added to an event later never ride along,
 * and names exactly one conversation the contact is a live participant of.
 *
 * Message content never travels on this stream. Streamed text can be private
 * scratchpad that only the finished row marks as such, and a turn's reply can
 * live on an earlier row than the one its completion names, so the stream
 * says which conversation's messages changed and the contact reads them back
 * through the shared messages route, which applies the contact projection.
 *
 * Membership is read when the event is emitted, so a conversation shared
 * mid-stream starts delivering and a removed participant stops receiving
 * without reconnecting.
 */

import { randomUUID } from "node:crypto";

import type { AssistantEvent, AssistantEventEnvelope } from "../api/index.js";
import { buildSyncChangedMessage } from "../daemon/message-types/sync.js";
import { isParticipant } from "../persistence/conversation-participants.js";

const CONVERSATION_SYNC_TAG = /^conversation:(.+):(?:messages|metadata)$/;

function envelopeFor(
  event: AssistantEventEnvelope,
  conversationId: string,
  message: AssistantEvent,
): AssistantEventEnvelope {
  return {
    id: randomUUID(),
    conversationId,
    emittedAt: event.emittedAt,
    message,
  };
}

/**
 * The event's conversation, when the envelope and its payload agree on one
 * and the principal participates in it.
 */
function memberConversation(
  event: AssistantEventEnvelope,
  payloadConversationId: string,
  principalId: string,
): string | null {
  const { conversationId } = event;
  if (!conversationId || conversationId !== payloadConversationId) {
    return null;
  }
  return isParticipant(conversationId, principalId) ? conversationId : null;
}

/**
 * One `sync_changed` per conversation the principal participates in, carrying
 * only that conversation's message and metadata tags. The origin client id is
 * dropped, since it names one of the guardian's devices.
 */
function projectSyncChanged(
  event: AssistantEventEnvelope,
  tags: string[],
  principalId: string,
): AssistantEventEnvelope[] {
  const tagsByConversation = new Map<string, string[]>();
  for (const tag of tags) {
    const conversationId = CONVERSATION_SYNC_TAG.exec(tag)?.[1];
    if (!conversationId) {
      continue;
    }
    const conversationTags = tagsByConversation.get(conversationId);
    if (conversationTags) {
      conversationTags.push(tag);
    } else {
      tagsByConversation.set(conversationId, [tag]);
    }
  }
  const projected: AssistantEventEnvelope[] = [];
  for (const [conversationId, conversationTags] of tagsByConversation) {
    if (isParticipant(conversationId, principalId)) {
      projected.push(
        envelopeFor(
          event,
          conversationId,
          buildSyncChangedMessage(conversationTags),
        ),
      );
    }
  }
  return projected;
}

/** The events a contact's stream carries in place of `event`, often none. */
export function projectEventForContact(
  event: AssistantEventEnvelope,
  principalId: string,
): AssistantEventEnvelope[] {
  const { message } = event;
  switch (message.type) {
    case "sync_changed":
      return projectSyncChanged(event, message.tags, principalId);
    case "conversation_title_updated": {
      const conversationId = memberConversation(
        event,
        message.conversationId,
        principalId,
      );
      return conversationId
        ? [
            envelopeFor(event, conversationId, {
              type: "conversation_title_updated",
              conversationId,
              title: message.title,
            }),
          ]
        : [];
    }
    case "assistant_activity_state": {
      // The status text and request id are dropped: the status text can
      // quote a tool's input.
      const conversationId = memberConversation(
        event,
        message.conversationId,
        principalId,
      );
      return conversationId
        ? [
            envelopeFor(event, conversationId, {
              type: "assistant_activity_state",
              conversationId,
              activityVersion: message.activityVersion,
              phase: message.phase,
              anchor: message.anchor,
              reason: message.reason,
            }),
          ]
        : [];
    }
    default:
      return [];
  }
}
