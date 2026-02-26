// Unified recording intent executor.
// Bridges the gap between recording-intent.ts (classification) and
// handlers/recording.ts (side effects), so both sessions.ts and misc.ts
// can share the same execution logic without duplicating switch/case blocks.

import type * as net from 'node:net';

import type { HandlerContext } from './handlers/shared.js';
import {
  handleRecordingPause,
  handleRecordingRestart,
  handleRecordingResume,
  handleRecordingStart,
  handleRecordingStop,
} from './handlers/recording.js';
import type { RecordingIntentResult } from './recording-intent.js';

export interface RecordingExecutionContext {
  conversationId: string;
  socket: net.Socket;
  ctx: HandlerContext;
}

export interface RecordingExecutionOutput {
  /** If true, the intent was fully handled (start_only / stop_only) -- handler should send completion and return */
  handled: boolean;
  /** Human-readable response text for the user */
  responseText?: string;
  /** For _with_remainder: the remaining text after stripping recording clauses */
  remainderText?: string;
  /** Whether a recording start should be/was initiated */
  pendingStart?: boolean;
  /** Whether a recording stop should be/was initiated */
  pendingStop?: boolean;
  /** Whether a restart is pending (for restart_with_remainder) */
  pendingRestart?: boolean;
  /** Whether handleRecordingStart succeeded (true) or was rejected (false). Only set for start_only / start_and_stop_only. */
  recordingStarted?: boolean;
}

export function executeRecordingIntent(
  result: RecordingIntentResult,
  context: RecordingExecutionContext,
): RecordingExecutionOutput {
  switch (result.kind) {
    case 'none':
      return { handled: false };

    case 'start_only': {
      const recordingId = handleRecordingStart(
        context.conversationId,
        { promptForSource: true },
        context.socket,
        context.ctx,
      );
      return {
        handled: true,
        recordingStarted: !!recordingId,
        responseText: recordingId
          ? 'Starting screen recording.'
          : 'A recording is already active.',
      };
    }

    case 'stop_only': {
      const stopped = handleRecordingStop(context.conversationId, context.ctx) !== undefined;
      return {
        handled: true,
        responseText: stopped
          ? 'Stopping the recording.'
          : 'No active recording to stop.',
      };
    }

    case 'start_with_remainder':
      return {
        handled: false,
        remainderText: result.remainder,
        pendingStart: true,
      };

    case 'stop_with_remainder':
      return {
        handled: false,
        remainderText: result.remainder,
        pendingStop: true,
      };

    case 'start_and_stop_only': {
      handleRecordingStop(context.conversationId, context.ctx);
      const recordingId = handleRecordingStart(
        context.conversationId,
        { promptForSource: true },
        context.socket,
        context.ctx,
      );
      return {
        handled: true,
        recordingStarted: !!recordingId,
        responseText: recordingId
          ? 'Stopping current recording and starting a new one.'
          : 'Stopping the recording.',
      };
    }

    case 'start_and_stop_with_remainder':
      return {
        handled: false,
        remainderText: result.remainder,
        pendingStart: true,
        pendingStop: true,
      };

    case 'restart_only': {
      const restartResult = handleRecordingRestart(
        context.conversationId,
        context.socket,
        context.ctx,
      );
      return {
        handled: true,
        responseText: restartResult.responseText,
      };
    }

    case 'restart_with_remainder':
      return {
        handled: false,
        remainderText: result.remainder,
        pendingRestart: true,
      };

    case 'pause_only': {
      const paused = handleRecordingPause(context.conversationId, context.ctx) !== undefined;
      return {
        handled: true,
        responseText: paused
          ? 'Pausing the recording.'
          : 'No active recording to pause.',
      };
    }

    case 'resume_only': {
      const resumed = handleRecordingResume(context.conversationId, context.ctx) !== undefined;
      return {
        handled: true,
        responseText: resumed
          ? 'Resuming the recording.'
          : 'No active recording to resume.',
      };
    }
  }
}
