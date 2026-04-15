/**
 * Meet — server → client push messages for live meeting state.
 *
 * Emitted by the assistant daemon as the Meet-bot progresses through its
 * lifecycle (joining → joined → left) and as in-meeting state changes
 * (participants, active speaker, transcript chunks).
 *
 * Keep payloads small and client-actionable: these events power the
 * macOS "In meeting" status panel and the conversation bridge's live
 * transcript feed. A client that missed an event can always refetch
 * authoritative state from the daemon's HTTP routes.
 */

/** A single participant in a meeting. Shape mirrors the wire-level type. */
export interface MeetParticipant {
  /** Stable participant identifier (provider-specific). */
  id: string;
  /** Display name of the participant. */
  name: string;
  /** Whether the participant is the meeting host. */
  isHost?: boolean;
  /** Whether the participant is the bot itself. */
  isSelf?: boolean;
}

/** The bot has started attempting to join a meeting. */
export interface MeetJoining {
  type: "meet.joining";
  meetingId: string;
  /** The Meet URL the bot was asked to join. */
  url: string;
}

/** The bot has successfully joined and is live in the meeting. */
export interface MeetJoined {
  type: "meet.joined";
  meetingId: string;
}

/** Participants joined and/or left the meeting since the last snapshot. */
export interface MeetParticipantChanged {
  type: "meet.participant_changed";
  meetingId: string;
  /** Participants who joined since the last snapshot. */
  joined: MeetParticipant[];
  /** Participants who left since the last snapshot. */
  left: MeetParticipant[];
}

/** The active speaker in the meeting changed. */
export interface MeetSpeakerChanged {
  type: "meet.speaker_changed";
  meetingId: string;
  /** Stable speaker identifier for the new active speaker. */
  speakerId: string;
  /** Display name of the new active speaker. */
  speakerName: string;
}

/**
 * A finalized chunk of transcribed speech. Interim chunks are filtered
 * out before publication so clients only render stable text.
 */
export interface MeetTranscriptChunk {
  type: "meet.transcript_chunk";
  meetingId: string;
  /** The transcribed text. */
  text: string;
  /** Human-readable speaker label, if the ASR provided one. */
  speakerLabel?: string;
  /** Stable speaker identifier across the meeting, if available. */
  speakerId?: string;
  /** ASR confidence in [0, 1], if available. */
  confidence?: number;
}

/** The bot has left the meeting. */
export interface MeetLeft {
  type: "meet.left";
  meetingId: string;
  /** Free-form reason passed to `leave()` (e.g. "user-requested", "timeout"). */
  reason: string;
}

/**
 * The assistant successfully posted a chat message into the meeting via
 * the bot's `/send_chat` endpoint. Emitted once per successful send so
 * SSE-subscribed clients can render the outbound chat without waiting for
 * the bot to echo it back through the transcript/chat stream.
 */
export interface MeetChatSent {
  type: "meet.chat_sent";
  meetingId: string;
  /** The text that was posted into the meeting's chat. */
  text: string;
}

/** The bot hit a non-recoverable error (container crash, join failure, etc.). */
export interface MeetError {
  type: "meet.error";
  meetingId: string;
  /** Human-readable error detail. */
  detail: string;
}

export type _MeetServerMessages =
  | MeetJoining
  | MeetJoined
  | MeetParticipantChanged
  | MeetSpeakerChanged
  | MeetTranscriptChunk
  | MeetLeft
  | MeetChatSent
  | MeetError;
