// Unified recording intent executor.
// Bridges the gap between recording-intent.ts (classification) and
// handlers/recording.ts (side effects), so both sessions.ts and misc.ts
// can share the same execution logic without duplicating switch/case blocks.

import type * as net from 'node:net';

import type { HandlerContext } from './handlers/shared.js';
import { handleRecordingStart, handleRecordingStop } from './handlers/recording.js';
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
  }
}
