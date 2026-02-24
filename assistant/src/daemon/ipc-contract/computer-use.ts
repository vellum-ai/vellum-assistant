// Computer use, task routing, ride shotgun, and watch observation types.

import type { UserMessageAttachment, IpcBlobRef } from './shared.js';

// === Client → Server ===

export interface CuSessionCreate {
  type: 'cu_session_create';
  sessionId: string;
  task: string;
  screenWidth: number;
  screenHeight: number;
  attachments?: UserMessageAttachment[];
  interactionType?: 'computer_use' | 'text_qa';
  /** Origin chat session for result injection (QA workflow). */
  reportToSessionId?: string;
  /** Marks this CU run as a QA/test workflow. */
  qaMode?: boolean;
  /** Optional target app name constraint for disambiguation. */
  targetAppName?: string;
  /** Optional target app bundle identifier for disambiguation. */
  targetAppBundleId?: string;
  /** When true, recording MUST start before any destructive action. */
  requiresRecording?: boolean;
  /** When true, target app must be visually frontmost during interaction and recording must be valid. */
  strictVisualQa?: boolean;
}

export interface CuRecordingStatus {
  type: 'cu_recording_status';
  sessionId: string;
  status: 'started' | 'failed' | 'stopped';
  reason?: string;
}

export interface CuSessionAbort {
  type: 'cu_session_abort';
  sessionId: string;
}

export interface CuAutoApproveUpdate {
  type: 'cu_auto_approve_update';
  sessionId: string;
  enabled: boolean;
}

export interface CuSessionFinalized {
  type: 'cu_session_finalized';
  sessionId: string;
  status: 'completed' | 'responded' | 'failed' | 'cancelled';
  summary: string;
  stepCount: number;
  recording?: {
    localPath: string;
    mimeType: 'video/mp4';
    sizeBytes: number;
    durationMs: number;
    width: number;
    height: number;
    captureScope: 'window' | 'display';
    includeAudio: boolean;
    targetBundleId?: string;
    expiresAt?: number;
  };
}

export interface CuObservation {
  type: 'cu_observation';
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
  coordinateOrigin?: 'top_left';
  /** Display ID used by screenshot capture for this observation. */
  captureDisplayId?: number;
  executionResult?: string;
  executionError?: string;
  axTreeBlob?: IpcBlobRef;
  screenshotBlob?: IpcBlobRef;
  /** Name of the frontmost application at observation time. */
  frontmostAppName?: string;
  /** Bundle ID of the frontmost application at observation time. */
  frontmostBundleId?: string;
}

export interface TaskSubmit {
  type: 'task_submit';
  task: string;
  screenWidth: number;
  screenHeight: number;
  attachments?: UserMessageAttachment[];
  source?: 'voice' | 'text';
  /** When set, overrides the QA-based requiresRecording computation. */
  requiresRecording?: boolean;
}

export interface RideShotgunStart {
  type: 'ride_shotgun_start';
  durationSeconds: number;
  intervalSeconds: number;
  mode?: 'observe' | 'learn';
  targetDomain?: string;
  /** Domain to auto-navigate (may differ from targetDomain, e.g. open.spotify.com vs spotify.com). */
  navigateDomain?: string;
  autoNavigate?: boolean;
}

export interface RideShotgunStop {
  type: 'ride_shotgun_stop';
  watchId: string;
}

export interface WatchObservation {
  type: 'watch_observation';
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

// === Server → Client ===

export interface CuAction {
  type: 'cu_action';
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  reasoning?: string;
  stepNumber: number;
}

export interface CuComplete {
  type: 'cu_complete';
  sessionId: string;
  summary: string;
  stepCount: number;
  isResponse?: boolean;
}

export interface CuError {
  type: 'cu_error';
  sessionId: string;
  message: string;
}

export interface TaskRouted {
  type: 'task_routed';
  sessionId: string;
  interactionType: 'computer_use' | 'text_qa';
  /** The task text passed to the escalated session. */
  task?: string;
  /** Set when a text_qa session escalates to computer_use via computer_use_request_control. */
  escalatedFrom?: string;
  /** Whether this is a QA/test workflow session. */
  qaMode?: boolean;
  /** The originating chat session ID for result injection. */
  reportToSessionId?: string;
  /** Recording retention in days (from daemon config). */
  retentionDays?: number;
  /** Capture scope for QA recording (from daemon config). */
  captureScope?: 'window' | 'display';
  /** Whether to include audio in QA recording (from daemon config). */
  includeAudio?: boolean;
  /** Target app name for frontmost-app guard (from target-app-hints). */
  targetAppName?: string;
  /** Target app bundle ID for frontmost-app guard (from target-app-hints). */
  targetAppBundleId?: string;
  /** When true, recording MUST start before any destructive action. */
  requiresRecording?: boolean;
  /** When true, target app must be visually frontmost during interaction and recording must be valid. */
  strictVisualQa?: boolean;
}

export interface RideShotgunProgress {
  type: 'ride_shotgun_progress';
  watchId: string;
  message: string;
  networkEntryCount?: number;
  statusMessage?: string;
  idleHint?: boolean;
}

export interface RideShotgunResult {
  type: 'ride_shotgun_result';
  sessionId: string;
  watchId: string;
  summary: string;
  observationCount: number;
  recordingId?: string;
  recordingPath?: string;
}

export interface WatchStarted {
  type: 'watch_started';
  sessionId: string;
  watchId: string;
  durationSeconds: number;
  intervalSeconds: number;
}

export interface WatchCompleteRequest {
  type: 'watch_complete_request';
  sessionId: string;
  watchId: string;
}
