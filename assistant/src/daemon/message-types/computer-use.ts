// Computer use and recording types.
//
// The recording lifecycle server→client events (start/stop/pause/resume) are
// single-sourced from their canonical `api/events` wire schemas; the shared
// `RecordingOptions` shape is re-exported from there for barrel consumers.

import type {
  RecordingPauseEvent,
  RecordingResumeEvent,
  RecordingStartEvent,
  RecordingStopEvent,
} from "../../api/events/recording.js";
import type { CommandIntent, UserMessageAttachment } from "./shared.js";

export type { RecordingOptions } from "../../api/events/recording.js";

// === Client → Server ===

export interface TaskSubmit {
  type: "task_submit";
  task: string;
  screenWidth: number;
  screenHeight: number;
  attachments?: UserMessageAttachment[];
  source?: "voice" | "text";
  /** Structured command intent — bypasses text parsing when present. */
  commandIntent?: CommandIntent;
}

/** Client → Server: recording lifecycle status update. */
export interface RecordingStatus {
  type: "recording_status";
  conversationId: string; // matches recordingId from RecordingStartEvent
  status:
    | "started"
    | "stopped"
    | "failed"
    | "restart_cancelled"
    | "paused"
    | "resumed";
  filePath?: string; // on stop
  durationMs?: number; // on stop
  error?: string; // on failure
  attachToConversationId?: string;
  /** Operation token for restart race hardening — matches the token from RecordingStartEvent. */
  operationToken?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _ComputerUseClientMessages = TaskSubmit | RecordingStatus;

export type _ComputerUseServerMessages =
  | RecordingStartEvent
  | RecordingStopEvent
  | RecordingPauseEvent
  | RecordingResumeEvent;
