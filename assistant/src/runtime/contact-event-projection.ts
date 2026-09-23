/**
 * Projection from an assistant event to what a trusted contact's event stream
 * may carry.
 *
 * The projection is an allowlist over event types: an event reaches a contact
 * only when its type is handled below, so reasoning and text deltas, tool
 * traffic, prompts meant for the guardian, and any event type added later are
 * dropped until they are explicitly allowed. Each allowed event is rebuilt
 * from its known fields, so fields added to an event later never ride along,
 * and names exactly one conversation the contact participates in, or did
 * until that event.
 *
 * Message content never travels on this stream. Streamed text can be private
 * scratchpad that only the finished row marks as such, and a turn's reply can
 * live on an earlier row than the one its completion names, so the stream
 * says which conversation's messages changed and the contact reads them back
 * through the shared messages route, which applies the contact projection.
 *
 * Membership is read when each event is emitted, so a conversation shared
 * mid-stream starts delivering and a removed participant stops receiving
 * without reconnecting. A stream remembers the conversations its contact has
 * been a member of, and when that set changes it sends a membership
 * invalidation naming the conversation and the contact's own conversation
 * list. That notice survives a removal or a deletion, which clears the
 * membership before anything about it is published, and never names a
 * conversation the contact was not in.
 *
 * One event reaches a contact outside membership: the close-out of their own
 * queued message when it was dropped because they lost access. Nothing on the
 * event says whose message it was, so the drop is noted here by the code that
 * dropped it, and only that sender's streams forward it.
 */

import { randomUUID } from "node:crypto";

import type { AssistantEvent, AssistantEventEnvelope } from "../api/index.js";
import {
  buildSyncChangedMessage,
  conversationMetadataSyncTag,
  SYNC_TAGS,
} from "../daemon/message-types/sync.js";
import {
  isParticipant,
  listConversationIdsForPrincipal,
} from "../persistence/conversation-participants.js";

const CONVERSATION_SYNC_TAG = /^conversation:(.+):(?:messages|metadata)$/;

/** How long a dropped message's note waits for its event to be projected. */
const DROPPED_NOTE_TTL_MS = 60_000;
const MAX_DROPPED_NOTES = 256;

/** Queued messages dropped because their sender lost access, by request id. */
const droppedOwnMessages = new Map<
  string,
  { principalId: string; conversationId: string; expiresAt: number }
>();

/**
 * Record that a contact's queued message was dropped because they lost
 * access, so the `message_queued_deleted` that closes it out reaches that
 * contact's own streams. Called before the event is broadcast.
 */
export function noteDroppedOwnMessage(note: {
  requestId: string;
  principalId: string;
  conversationId: string;
}): void {
  const now = Date.now();
  for (const [requestId, entry] of droppedOwnMessages) {
    if (entry.expiresAt > now && droppedOwnMessages.size < MAX_DROPPED_NOTES) {
      break;
    }
    droppedOwnMessages.delete(requestId);
  }
  droppedOwnMessages.set(note.requestId, {
    principalId: note.principalId,
    conversationId: note.conversationId,
    expiresAt: now + DROPPED_NOTE_TTL_MS,
  });
}

function droppedMessageSender(
  requestId: string,
  conversationId: string,
): string | undefined {
  const note = droppedOwnMessages.get(requestId);
  return note &&
    note.conversationId === conversationId &&
    note.expiresAt > Date.now()
    ? note.principalId
    : undefined;
}

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

/** A `sync_changed` event's per-conversation tags, grouped by conversation. */
function tagsByConversation(tags: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const tag of tags) {
    const conversationId = CONVERSATION_SYNC_TAG.exec(tag)?.[1];
    if (!conversationId) {
      continue;
    }
    const conversationTags = grouped.get(conversationId);
    if (conversationTags) {
      conversationTags.push(tag);
    } else {
      grouped.set(conversationId, [tag]);
    }
  }
  return grouped;
}

type Membership = "member" | "joined" | "left" | "none";

/**
 * The events a contact's stream carries in place of each event, often none.
 * Holds the conversations the contact is known to be in, so one projection
 * serves one stream.
 */
export function createContactEventProjection(
  principalId: string,
): (event: AssistantEventEnvelope) => AssistantEventEnvelope[] {
  const known = new Set(listConversationIdsForPrincipal(principalId));

  function membershipOf(conversationId: string): Membership {
    const knew = known.has(conversationId);
    if (isParticipant(conversationId, principalId)) {
      known.add(conversationId);
      return knew ? "member" : "joined";
    }
    known.delete(conversationId);
    return knew ? "left" : "none";
  }

  /**
   * The frames for one conversation an event concerns: `build`'s event while
   * the contact is a member, preceded or replaced by a membership
   * invalidation when they have just joined or left.
   */
  function framesFor(
    event: AssistantEventEnvelope,
    conversationId: string,
    build: () => AssistantEvent,
  ): AssistantEventEnvelope[] {
    const membershipChanged = () =>
      envelopeFor(
        event,
        conversationId,
        buildSyncChangedMessage([
          SYNC_TAGS.sharedConversationsList,
          conversationMetadataSyncTag(conversationId),
        ]),
      );
    switch (membershipOf(conversationId)) {
      case "member":
        return [envelopeFor(event, conversationId, build())];
      case "joined":
        return [
          membershipChanged(),
          envelopeFor(event, conversationId, build()),
        ];
      case "left":
        return [membershipChanged()];
      case "none":
        return [];
    }
  }

  return (event) => {
    const { message } = event;
    switch (message.type) {
      case "sync_changed":
        // One event per conversation, carrying only that conversation's
        // tags. The origin client id is dropped, since it names one of the
        // guardian's devices.
        return Array.from(
          tagsByConversation(message.tags),
          ([conversationId, tags]) =>
            framesFor(event, conversationId, () =>
              buildSyncChangedMessage(tags),
            ),
        ).flat();
      case "conversation_title_updated":
        return event.conversationId === message.conversationId
          ? framesFor(event, message.conversationId, () => ({
              type: "conversation_title_updated",
              conversationId: message.conversationId,
              title: message.title,
            }))
          : [];
      case "assistant_activity_state":
        // The status text and request id are dropped: the status text can
        // quote a tool's input.
        return event.conversationId === message.conversationId
          ? framesFor(event, message.conversationId, () => ({
              type: "assistant_activity_state",
              conversationId: message.conversationId,
              activityVersion: message.activityVersion,
              phase: message.phase,
              anchor: message.anchor,
              reason: message.reason,
            }))
          : [];
      case "message_queued_deleted":
        // Only the close-out of this contact's own dropped message, and only
        // the fields that identify it to the client that sent it.
        return event.conversationId === message.conversationId &&
          droppedMessageSender(message.requestId, message.conversationId) ===
            principalId
          ? [
              envelopeFor(event, message.conversationId, {
                type: "message_queued_deleted",
                conversationId: message.conversationId,
                requestId: message.requestId,
                ...(message.clientMessageId
                  ? { clientMessageId: message.clientMessageId }
                  : {}),
              }),
            ]
          : [];
      default:
        return [];
    }
  };
}
