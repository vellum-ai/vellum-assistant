// Live transcript types for system audio capture and transcription.

// === Client → Server ===

/** Signals that live audio listening has begun. */
export interface LiveTranscriptStart {
  type: 'live_transcript_start';
}

/** Signals that live audio listening has stopped. */
export interface LiveTranscriptStop {
  type: 'live_transcript_stop';
}

/** A transcript update from the client's live audio capture. */
export interface LiveTranscriptUpdate {
  type: 'live_transcript_update';
  /** The transcribed text segment. */
  text: string;
  /** Unix timestamp (ms) when the segment was captured. */
  timestamp: number;
  /** Whether this is a finalized segment (vs. a partial/interim result). */
  isFinal: boolean;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _LiveTranscriptClientMessages =
  | LiveTranscriptStart
  | LiveTranscriptStop
  | LiveTranscriptUpdate;
