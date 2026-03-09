// Unified recording intent executor.
// Bridges the gap between recording-intent.ts (classification) and
// handlers/recording.ts (side effects), so both sessions.ts and misc.ts
// can share the same execution logic without duplicating switch/case blocks.

import {
  handleRecordingPause,
  handleRecordingRestart,
  handleRecordingResume,
  handleRecordingStart,
  handleRecordingStop,
  isRecordingIdle,
} from "./handlers/recording.js";
import type { HandlerContext } from "./handlers/shared.js";
import type { RecordingIntentResult } from "./recording-intent.js";

export interface RecordingExecutionContext {
  conversationId: string;
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
    case "none":
      return { handled: false };

    case "start_only": {
      const recordingId = handleRecordingStart(
        context.conversationId,
        { promptForSource: true },
        context.ctx,
      );
      return {
        handled: true,
        recordingStarted: !!recordingId,
        responseText: recordingId
          ? "Starting screen recording."
          : "A recording is already active.",
      };
    }

    case "stop_only": {
      const stopped =
        handleRecordingStop(context.conversationId, context.ctx) !== undefined;
      return {
        handled: true,
        responseText: stopped
          ? "Stopping the recording."
          : "No active recording to stop.",
      };
    }

    case "start_with_remainder":
      return {
        handled: false,
        remainderText: result.remainder,
        pendingStart: true,
      };

    case "stop_with_remainder":
      return {
        handled: false,
        remainderText: result.remainder,
        pendingStop: true,
      };

    case "start_and_stop_only": {
      // Route through handleRecordingRestart which properly cleans up maps
      // between stop and start, preventing the "already active" guard from
      // blocking the new recording.
      const restartResult = handleRecordingRestart(
        context.conversationId,
        context.ctx,
      );

      // When there was no active recording to restart, fall back to a plain
      // start — the user said "stop and start" but nothing was recording, so
      // the stop is a no-op and we just start a new recording.
      // Only fall back for this specific reason; "restart_in_progress" should
      // not start a duplicate recording.
      if (
        !restartResult.initiated &&
        restartResult.reason === "no_active_recording"
      ) {
        const recordingId = handleRecordingStart(
          context.conversationId,
          { promptForSource: true },
          context.ctx,
        );
        return {
          handled: true,
          recordingStarted: !!recordingId,
          responseText: recordingId
            ? "Starting screen recording."
            : "A recording is already active.",
        };
      }

      return {
        handled: true,
        recordingStarted: restartResult.initiated,
        responseText: restartResult.initiated
          ? "Stopping current recording and starting a new one."
          : restartResult.responseText,
      };
    }

    case "start_and_stop_with_remainder":
      // When there's no active recording, fall back to a plain start rather
      // than a restart — the stop is a no-op and we just need to start.
      return {
        handled: false,
        remainderText: result.remainder,
        ...(isRecordingIdle()
          ? { pendingStart: true }
          : { pendingRestart: true }),
      };

    case "restart_only": {
      const restartResult = handleRecordingRestart(
        context.conversationId,
        context.ctx,
      );
      return {
        handled: true,
        responseText: restartResult.responseText,
      };
    }

    case "restart_with_remainder":
      return {
        handled: false,
        remainderText: result.remainder,
        pendingRestart: true,
      };

    case "pause_only": {
      const paused =
        handleRecordingPause(context.conversationId, context.ctx) !== undefined;
      return {
        handled: true,
        responseText: paused
          ? "Pausing the recording."
          : "No active recording to pause.",
      };
    }

    case "resume_only": {
      const resumed =
        handleRecordingResume(context.conversationId, context.ctx) !==
        undefined;
      return {
        handled: true,
        responseText: resumed
          ? "Resuming the recording."
          : "No active recording to resume.",
      };
    }
  }
}
