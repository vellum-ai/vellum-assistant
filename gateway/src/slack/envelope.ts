import { z } from "zod";
import type {
  SlackAppMentionEvent,
  SlackBlockActionsPayload,
  SlackChannelMessageEvent,
  SlackDirectMessageEvent,
  SlackMessageChangedEvent,
  SlackMessageDeletedEvent,
  SlackReactionEvent,
} from "./message-schemas.js";

const optionalString = () => z.string().optional().catch(undefined);

/**
 * The inner Slack event carried by an `events_api` envelope. This is a
 * pass-through: the frame parser confirms it is an object, but each normalizer
 * re-validates it with its own tolerant schema (per-leaf validation), so the
 * frame parser never re-models the event's fields.
 */
export type SlackInboundEvent =
  | SlackAppMentionEvent
  | SlackDirectMessageEvent
  | SlackChannelMessageEvent
  | SlackMessageChangedEvent
  | SlackMessageDeletedEvent
  | SlackReactionEvent;

/**
 * The `payload` object on a Socket Mode envelope. Serves two envelope kinds:
 * `events_api` (wraps `event` + delivery metadata) and `interactive` (the
 * Block Kit interaction payload itself). Extra keys are preserved so the
 * interactive path can hand the whole payload to `normalizeSlackBlockActions`,
 * which safeParses it.
 */
export interface SlackEnvelopePayload {
  event_id?: string;
  event_time?: number;
  team_id?: string;
  event?: SlackInboundEvent;
  type?: string;
  trigger_id?: string;
  user?: { id?: string; username?: string; name?: string };
  channel?: { id?: string; name?: string };
  message?: { ts?: string; thread_ts?: string; text?: string };
  actions?: SlackBlockActionsPayload["actions"];
  [key: string]: unknown;
}

/** A validated Slack Socket Mode envelope (frame). */
export interface SlackEnvelope {
  envelope_id?: string;
  type?: string;
  reason?: string;
  payload?: SlackEnvelopePayload;
}

const slackEnvelopeSchema = z.object({
  envelope_id: optionalString(),
  type: optionalString(),
  reason: optionalString(),
  payload: z
    .object({
      event_id: optionalString(),
      event_time: z.number().optional().catch(undefined),
      team_id: optionalString(),
      // The inner event / interaction payload stay opaque objects here — the
      // normalizers own their validation. We only confirm it is an object.
      event: z.record(z.string(), z.unknown()).optional().catch(undefined),
    })
    .passthrough()
    .optional()
    .catch(undefined),
});

/**
 * Parse and tolerantly validate an untrusted Slack Socket Mode frame.
 *
 * This is the single seam where the raw WebSocket text frame is turned into a
 * typed envelope: it owns the `JSON.parse`, drops non-JSON / non-object frames,
 * and validates the envelope wrapper (envelope_id / type / payload metadata).
 * The inner `event` and interaction payload remain pass-through objects that
 * each normalizer re-validates, so this never re-models what the leaves own.
 *
 * Returns `null` for a frame that is not JSON or not an object.
 */
export function parseSlackEnvelope(raw: string): SlackEnvelope | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = slackEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  // The schema validates the frame; `event` is confirmed to be an object and
  // typed as the inbound union for the (already-guarded) dispatch, which each
  // normalizer then re-validates.
  return parsed.data as SlackEnvelope;
}
