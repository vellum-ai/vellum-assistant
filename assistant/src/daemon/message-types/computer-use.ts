// Computer use and recording types.

import type { CommandIntent, UserMessageAttachment } from "./shared.js";

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

// === Recording ===

/** Recording options shared across standalone and CU recording flows. */
export interface RecordingOptions {
  captureScope?: "display" | "window";
  displayId?: string; // CGDirectDisplayID as string
  windowId?: number; // CGWindowID
  includeAudio?: boolean;
  includeMicrophone?: boolean;
  promptForSource?: boolean; // show source picker
}

/** Client → Server: recording lifecycle status update. */
export interface RecordingStatus {
  type: "recording_status";
  conversationId: string; // matches recordingId from RecordingStart
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
  /** Operation token for restart race hardening — matches the token from RecordingStart. */
  operationToken?: string;
}

// === Server → Client ===

/** Server → Client: start a recording. */
export interface RecordingStart {
  type: "recording_start";
  recordingId: string; // daemon-assigned UUID
  attachToConversationId?: string;
  options?: RecordingOptions;
  /** Operation token for restart race hardening — stale completions with mismatched tokens are rejected. */
  operationToken?: string;
}

/** Server → Client: stop a recording. */
export interface RecordingStop {
  type: "recording_stop";
  recordingId: string; // matches RecordingStart.recordingId
}

/** Server → Client: pause the active recording. */
export interface RecordingPause {
  type: "recording_pause";
  recordingId: string;
}

/** Server → Client: resume a paused recording. */
export interface RecordingResume {
  type: "recording_resume";
  recordingId: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _ComputerUseClientMessages = TaskSubmit | RecordingStatus;

export type _ComputerUseServerMessages =
  | RecordingStart
  | RecordingStop
  | RecordingPause
  | RecordingResume;
