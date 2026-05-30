import { z } from "zod";

/**
 * Sent to a single reconnecting SSE client when its `lastSeenSeq` is
 * older than the oldest entry still in the daemon's ring buffer for
 * the conversation. The client should treat this as "your live cursor
 * is stale -- refetch a snapshot covering the message range you've
 * missed via the normal messages API, then resume live from the next
 * delivered event."
 *
 * Emitted directly into the reconnecting subscriber's stream by the
 * `/events` route handler -- it does not go through `broadcastMessage`,
 * is never fanned out to other subscribers, and carries no `seq` (it
 * is an out-of-band control signal, not part of the conversation's
 * normal event sequence).
 */
export interface StreamResyncRequiredMessage {
  type: "stream_resync_required";
  conversationId: string;
}

export const StreamResyncRequiredMessageSchema = z
  .object({
    type: z.literal("stream_resync_required"),
    conversationId: z.string().min(1),
  })
  .strict();

export type _StreamServerMessages = StreamResyncRequiredMessage;
