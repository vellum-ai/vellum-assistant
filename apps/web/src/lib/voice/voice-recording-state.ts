
import { useCallback, useEffect, useReducer, useRef } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Discriminated union representing the phases of a voice recording session.
 * Mirrors the macOS app's `DictationState` enum.
 */
export type VoiceRecordingState =
  | { phase: "idle" }
  | { phase: "recording" }
  | { phase: "processing" }
  | { phase: "done" }
  | { phase: "error"; code: string };

// ---------------------------------------------------------------------------
// Actions & Reducer (exported for testing)
// ---------------------------------------------------------------------------

export type VoiceRecordingAction =
  | { type: "START_RECORDING" }
  | { type: "STOP_RECORDING" }
  | { type: "FINALIZE" }
  | { type: "FAIL"; code: string }
  | { type: "RESET" }
  | { type: "DONE_TIMEOUT" };

/**
 * Pure reducer for voice recording state transitions.
 *
 * Transitions:
 *   idle → recording  (START_RECORDING)
 *   recording → processing  (STOP_RECORDING)
 *   processing → done  (FINALIZE)
 *   done → idle  (DONE_TIMEOUT, auto after 800 ms)
 *   any → error  (FAIL)
 *   any → idle  (RESET)
 */
export function voiceRecordingReducer(
  state: VoiceRecordingState,
  action: VoiceRecordingAction,
): VoiceRecordingState {
  switch (action.type) {
    case "START_RECORDING":
      return { phase: "recording" };
    case "STOP_RECORDING":
      return { phase: "processing" };
    case "FINALIZE":
      return { phase: "done" };
    case "FAIL":
      return { phase: "error", code: action.code };
    case "RESET":
      return { phase: "idle" };
    case "DONE_TIMEOUT":
      return { phase: "idle" };
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Duration (ms) that the "done" state is shown before auto-dismissing. */
export const DONE_DISMISS_MS = 800;

/** Duration (ms) that the "error" state is shown before auto-dismissing. */
export const ERROR_DISMISS_MS = 3000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseVoiceRecordingStateReturn {
  state: VoiceRecordingState;
  startRecording: () => void;
  stopRecording: () => void;
  finalize: () => void;
  fail: (code: string) => void;
  reset: () => void;
}

/**
 * Manages voice-recording state transitions.
 *
 * On entering `done`, sets an 800 ms timeout that auto-transitions back to
 * `idle` (matching macOS `showDoneAndDismiss`). Clears the timeout on unmount
 * or if another transition fires first.
 */
export function useVoiceRecordingState(): UseVoiceRecordingStateReturn {
  const [state, dispatch] = useReducer(voiceRecordingReducer, {
    phase: "idle",
  });

  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDoneTimer = useCallback(() => {
    if (doneTimerRef.current !== null) {
      clearTimeout(doneTimerRef.current);
      doneTimerRef.current = null;
    }
  }, []);

  const startRecording = useCallback(() => {
    clearDoneTimer();
    dispatch({ type: "START_RECORDING" });
  }, [clearDoneTimer]);

  const stopRecording = useCallback(() => {
    clearDoneTimer();
    dispatch({ type: "STOP_RECORDING" });
  }, [clearDoneTimer]);

  const finalize = useCallback(() => {
    clearDoneTimer();
    dispatch({ type: "FINALIZE" });
    doneTimerRef.current = setTimeout(() => {
      doneTimerRef.current = null;
      dispatch({ type: "DONE_TIMEOUT" });
    }, DONE_DISMISS_MS);
  }, [clearDoneTimer]);

  const fail = useCallback(
    (code: string) => {
      clearDoneTimer();
      dispatch({ type: "FAIL", code });
      doneTimerRef.current = setTimeout(() => {
        doneTimerRef.current = null;
        dispatch({ type: "RESET" });
      }, ERROR_DISMISS_MS);
    },
    [clearDoneTimer],
  );

  const reset = useCallback(() => {
    clearDoneTimer();
    dispatch({ type: "RESET" });
  }, [clearDoneTimer]);

  useEffect(() => {
    return () => {
      clearDoneTimer();
    };
  }, [clearDoneTimer]);

  return { state, startRecording, stopRecording, finalize, fail, reset };
}
