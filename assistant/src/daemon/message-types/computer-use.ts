// Computer use, task routing, ride shotgun, and watch observation types.

import type {
  CommandIntent,
  UserMessageAttachment,
} from "./shared.js";

// === Client → Server ===

export interface CuSessionCreate {
  type: "cu_session_create";
  sessionId: string;
  task: string;
  screenWidth: number;
  screenHeight: number;
  attachments?: UserMessageAttachment[];
  interactionType?: "computer_use" | "text_qa";
}

export interface CuSessionAbort {
  type: "cu_session_abort";
  sessionId: string;
}

export interface CuObservation {
  type: "cu_observation";
  sessionId: string;
  axTree?: string;
  axDiff?: string;
  secondaryWindows?: string;
  screenshot?: string;
  /** Screenshot image width in pixels (`Px`). */
  screenshotWidthPx?: number;
  /** Screenshot image height in pixels (`Px`). */
  screenshotHeightPx?: number;
  /** Screen width in macOS points (`Pt`) used by native execution. */
  screenWidthPt?: number;
  /** Screen height in macOS points (`Pt`) used by native execution. */
  screenHeightPt?: number;
  /** Coordinate origin convention used by the observation payload. */
  coordinateOrigin?: "top_left";
  /** Display ID used by screenshot capture for this observation. */
  captureDisplayId?: number;
  executionResult?: string;
  executionError?: string;
  /** Free-form guidance from the user, injected mid-turn to steer the agent. */
  userGuidance?: string;
}

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

export interface RideShotgunStart {
  type: "ride_shotgun_start";
  durationSeconds: number;
  intervalSeconds: number;
  mode?: "observe" | "learn";
  targetDomain?: string;
  /** Domain to auto-navigate (may differ from targetDomain, e.g. open.spotify.com vs spotify.com). */
  navigateDomain?: string;
  autoNavigate?: boolean;
}

export interface RideShotgunStop {
  type: "ride_shotgun_stop";
  watchId: string;
}

export interface WatchObservation {
  type: "watch_observation";
  watchId: string;
  sessionId: string;
  ocrText: string;
  appName?: string;
  windowTitle?: string;
  bundleIdentifier?: string;
  timestamp: number;
  captureIndex: number;
  totalExpected: number;
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
  sessionId: string; // matches recordingId from RecordingStart
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

export interface CuAction {
  type: "cu_action";
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  reasoning?: string;
  stepNumber: number;
}

export interface CuComplete {
  type: "cu_complete";
  sessionId: string;
  summary: string;
  stepCount: number;
  isResponse?: boolean;
}

export interface CuError {
  type: "cu_error";
  sessionId: string;
  message: string;
}

export interface TaskRouted {
  type: "task_routed";
  sessionId: string;
  interactionType: "computer_use" | "text_qa";
  /** The task text passed to the escalated session. */
  task?: string;
  /** Set when a text_qa session escalates to computer_use via computer_use_request_control. */
  escalatedFrom?: string;
}

export interface RideShotgunProgress {
  type: "ride_shotgun_progress";
  watchId: string;
  message: string;
  networkEntryCount?: number;
  statusMessage?: string;
  idleHint?: boolean;
}

export interface RideShotgunResult {
  type: "ride_shotgun_result";
  sessionId: string;
  watchId: string;
  summary: string;
  observationCount: number;
  recordingId?: string;
  recordingPath?: string;
}

export interface WatchStarted {
  type: "watch_started";
  sessionId: string;
  watchId: string;
  durationSeconds: number;
  intervalSeconds: number;
}

export interface WatchCompleteRequest {
  type: "watch_complete_request";
  sessionId: string;
  watchId: string;
}

/** Server → Client: bootstrap failure during learn-mode recording setup. */
export interface RideShotgunError {
  type: "ride_shotgun_error";
  watchId: string;
  sessionId: string;
  message: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _ComputerUseClientMessages =
  | CuSessionCreate
  | CuSessionAbort
  | CuObservation
  | TaskSubmit
  | RideShotgunStart
  | RideShotgunStop
  | WatchObservation
  | RecordingStatus;

export type _ComputerUseServerMessages =
  | CuAction
  | CuComplete
  | CuError
  | TaskRouted
  | RideShotgunProgress
  | RideShotgunResult
  | RideShotgunError
  | WatchStarted
  | WatchCompleteRequest
  | RecordingStart
  | RecordingStop
  | RecordingPause
  | RecordingResume;
