/**
 * Events emitted by the meet-bot and consumed by the assistant daemon.
 *
 * All events share a `type` discriminator, a `meetingId`, and a `timestamp`
 * (ISO-8601 string). Consumers should parse incoming payloads with the
 * {@link MeetBotEventSchema} discriminated union before branching on `type`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Opaque identifier for the meeting the bot is participating in. */
const MeetingIdSchema = z.string().min(1);

/** ISO-8601 timestamp of when the event occurred on the bot side. */
const TimestampSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// transcript.chunk
// ---------------------------------------------------------------------------

/**
 * A chunk of transcribed speech produced by the bot's ASR pipeline.
 *
 * `isFinal` indicates whether the ASR engine considers this chunk stable
 * (i.e. will not be rewritten by later context). Interim chunks may be
 * superseded by a later final chunk covering the same time range.
 */
export const TranscriptChunkEventSchema = z.object({
  type: z.literal("transcript.chunk"),
  meetingId: MeetingIdSchema,
  timestamp: TimestampSchema,
  /** Whether the ASR engine considers this chunk final (stable). */
  isFinal: z.boolean(),
  /** The transcribed text for this chunk. */
  text: z.string(),
  /** Human-readable label for the speaker, if the ASR provided one. */
  speakerLabel: z.string().optional(),
  /** Stable speaker identifier across the meeting, if available. */
  speakerId: z.string().optional(),
  /** ASR confidence in [0, 1], if available. */
  confidence: z.number().min(0).max(1).optional(),
});
export type TranscriptChunkEvent = z.infer<typeof TranscriptChunkEventSchema>;

// ---------------------------------------------------------------------------
// speaker.change
// ---------------------------------------------------------------------------

/** Emitted when the active speaker changes in the meeting. */
export const SpeakerChangeEventSchema = z.object({
  type: z.literal("speaker.change"),
  meetingId: MeetingIdSchema,
  timestamp: TimestampSchema,
  /** Stable speaker identifier for the new active speaker. */
  speakerId: z.string(),
  /** Display name of the new active speaker. */
  speakerName: z.string(),
});
export type SpeakerChangeEvent = z.infer<typeof SpeakerChangeEventSchema>;

// ---------------------------------------------------------------------------
// Participant + participant.change
// ---------------------------------------------------------------------------

/** A participant in the meeting. */
export const ParticipantSchema = z.object({
  /** Stable participant identifier (provider-specific). */
  id: z.string(),
  /** Display name of the participant. */
  name: z.string(),
  /** Whether the participant is the meeting host. */
  isHost: z.boolean().optional(),
  /** Whether the participant is the bot itself. */
  isSelf: z.boolean().optional(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

/**
 * Emitted when participants join or leave the meeting.
 *
 * `joined` and `left` are arrays so multiple simultaneous changes can be
 * reported in a single event. Both arrays may be empty, but at least one
 * should be non-empty when an event is emitted.
 */
export const ParticipantChangeEventSchema = z.object({
  type: z.literal("participant.change"),
  meetingId: MeetingIdSchema,
  timestamp: TimestampSchema,
  /** Participants who joined since the last snapshot. */
  joined: z.array(ParticipantSchema),
  /** Participants who left since the last snapshot. */
  left: z.array(ParticipantSchema),
});
export type ParticipantChangeEvent = z.infer<
  typeof ParticipantChangeEventSchema
>;

// ---------------------------------------------------------------------------
// chat.inbound
// ---------------------------------------------------------------------------

/** Emitted when a chat message is received from another participant. */
export const InboundChatEventSchema = z.object({
  type: z.literal("chat.inbound"),
  meetingId: MeetingIdSchema,
  timestamp: TimestampSchema,
  /** Stable identifier of the sender. */
  fromId: z.string(),
  /** Display name of the sender. */
  fromName: z.string(),
  /** The chat message text. */
  text: z.string(),
  /**
   * True when the event is a replay of a chat message that was already in
   * the DOM when the reader attached — i.e. part of the meeting's pre-
   * existing chat history, not a message that arrived live. Consumers that
   * treat every inbound chat as an opportunity to wake the agent
   * (`chat-opportunity-detector`) must skip backfilled messages so an old
   * history entry doesn't consume the Tier 2 debounce slot and silently
   * drop a live message arriving right after attach.
   */
  isBackfill: z.boolean().optional(),
});
export type InboundChatEvent = z.infer<typeof InboundChatEventSchema>;

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

/** Lifecycle state values for the bot's connection to a meeting. */
export const LifecycleStateSchema = z.enum([
  "joining",
  "joined",
  "leaving",
  "left",
  "error",
]);
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;

/**
 * Emitted on every bot lifecycle transition.
 *
 * `detail` is an optional free-form string (e.g. an error message when
 * `state === "error"`).
 */
export const LifecycleEventSchema = z.object({
  type: z.literal("lifecycle"),
  meetingId: MeetingIdSchema,
  timestamp: TimestampSchema,
  state: LifecycleStateSchema,
  /** Optional human-readable detail (required-ish for `error`). */
  detail: z.string().optional(),
});
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

// ---------------------------------------------------------------------------
// MeetBotEvent — discriminated union
// ---------------------------------------------------------------------------

/**
 * Every event published by the meet-bot to the daemon is one of these
 * shapes. Consumers should parse incoming payloads with this schema to
 * both validate and narrow on `type`.
 */
export const MeetBotEventSchema = z.discriminatedUnion("type", [
  TranscriptChunkEventSchema,
  SpeakerChangeEventSchema,
  ParticipantChangeEventSchema,
  InboundChatEventSchema,
  LifecycleEventSchema,
]);
export type MeetBotEvent = z.infer<typeof MeetBotEventSchema>;

/** All event `type` discriminator values as a const tuple. */
export const MEET_BOT_EVENT_TYPES = [
  "transcript.chunk",
  "speaker.change",
  "participant.change",
  "chat.inbound",
  "lifecycle",
] as const;

export type MeetBotEventType = (typeof MEET_BOT_EVENT_TYPES)[number];
