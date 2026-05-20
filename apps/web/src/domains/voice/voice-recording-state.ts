
import { useCallback, useEffect, useRef, useState } from "react";

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
 * State machine:
 *   idle → recording  (startRecording)
 *   recording → processing  (stopRecording)
 *   processing → done  (finalize)
 *   done → idle  (auto after 800 ms)
 *   any → error  (fail)
 *   any → idle  (reset)
 *
 * On entering `done`, sets an 800 ms timeout that auto-transitions back to
 * `idle` (matching macOS `showDoneAndDismiss`). Clears the timeout on unmount
 * or if another transition fires first.
 */
export function useVoiceRecordingState(): UseVoiceRecordingStateReturn {
  const [state, setState] = useState<VoiceRecordingState>({ phase: "idle" });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startRecording = useCallback(() => {
    clearTimer();
    setState({ phase: "recording" });
  }, [clearTimer]);

  const stopRecording = useCallback(() => {
    clearTimer();
    setState({ phase: "processing" });
  }, [clearTimer]);

  const finalize = useCallback(() => {
    clearTimer();
    setState({ phase: "done" });
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setState({ phase: "idle" });
    }, DONE_DISMISS_MS);
  }, [clearTimer]);

  const fail = useCallback(
    (code: string) => {
      clearTimer();
      setState({ phase: "error", code });
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setState({ phase: "idle" });
      }, ERROR_DISMISS_MS);
    },
    [clearTimer],
  );

  const reset = useCallback(() => {
    clearTimer();
    setState({ phase: "idle" });
  }, [clearTimer]);

  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, [clearTimer]);

  return { state, startRecording, stopRecording, finalize, fail, reset };
}
