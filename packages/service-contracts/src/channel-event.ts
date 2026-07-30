/**
 * Provider-neutral envelope primitives: what happened, and where the content is.
 *
 * These sit in `service-contracts` because they name nothing gateway-specific:
 * an event kind and a content pointer mean the same thing to any producer. The
 * envelope that carries them, together with the gateway's trust verdict and
 * admission stamp, lives in `@vellumai/gateway-client`, which is where
 * gateway-to-daemon wire contracts belong and where the canonical trust
 * vocabulary already is.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Event kind
// ---------------------------------------------------------------------------

/**
 * The event families the gateway normalizes today, one per normalizer:
 * `message-normalizer`, `message-change-normalizer` (edit and delete),
 * `reaction-normalizer`, and `block-actions-normalizer`.
 */
export const CHANNEL_EVENT_KINDS = [
  "message",
  "message_edit",
  "message_delete",
  "reaction",
  "action",
] as const;

export type ChannelEventKind = (typeof CHANNEL_EVENT_KINDS)[number];

export const ChannelEventKindSchema = z.enum(CHANNEL_EVENT_KINDS);

// ---------------------------------------------------------------------------
// Content references
// ---------------------------------------------------------------------------

/**
 * Pointers to the event's content. Bodies and blobs are fetched by id rather
 * than inlined, so an envelope stays a routing and attribution record and does
 * not become a copy of the message.
 */
export const ChannelContentRefsSchema = z.strictObject({
  /** Provider message id this event is about. */
  externalMessageId: z.string().min(1).max(512),
  /** Attachment ids the ingress pipeline registered, in provider order. */
  attachmentIds: z.array(z.string().min(1).max(512)).max(64).optional(),
});

export type ChannelContentRefs = z.infer<typeof ChannelContentRefsSchema>;
