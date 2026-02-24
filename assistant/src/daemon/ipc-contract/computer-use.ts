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
}

export interface CuSessionAbort {
  type: 'cu_session_abort';
  sessionId: string;
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
}

export interface TaskSubmit {
  type: 'task_submit';
  task: string;
  screenWidth: number;
  screenHeight: number;
  attachments?: UserMessageAttachment[];
  source?: 'voice' | 'text';
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
}

export interface RideShotgunProgress {
  type: 'ride_shotgun_progress';
  watchId: string;
  message: string;
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
