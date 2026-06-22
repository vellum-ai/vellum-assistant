import { Check, Loader2, StopCircle, TriangleAlert } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";

import {
  getDictationOverlayState,
  requestDictationOverlayStop,
  setDictationOverlayInteractive,
  subscribeToDictationOverlayState,
} from "@/runtime/dictation-overlay";
import type { DictationOverlayState } from "@/runtime/is-electron";

/**
 * Live dictation pill rendered inside the Electron dictation overlay
 * BrowserWindow — a non-activating panel pinned top-center of the active
 * display while the user dictates via push-to-talk into another app. The
 * Electron port of the native Swift client's
 * `DictationOverlayWindow`: a status row (state icon + label), compact
 * audio meter, and optional two-line live transcription.
 *
 * Standalone (no auth, no RootLayout) like the Quick Input page; the
 * window canvas is transparent, so the page paints only the pill. The
 * main process owns visibility — this page just renders the latest state
 * it receives. Off-Electron the subscription no-ops and the page stays
 * blank.
 */
export function DictationOverlayPage() {
  const [state, setState] = useState<DictationOverlayState | null>(null);
  const stopButtonRef = useRef<HTMLButtonElement | null>(null);
  const interactiveRef = useRef(false);

  useEffect(() => {
    const unsubscribe = subscribeToDictationOverlayState(setState);
    // This route chunk loads lazily after the window is created, so the
    // session's first states can be pushed before the subscription above
    // registers and be dropped. Pull the latest to catch up — pushed states
    // are newer, so never overwrite one.
    void getDictationOverlayState().then((initial) => {
      if (initial) {
        setState((current) => current ?? initial);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    return () => {
      setDictationOverlayInteractive(false);
    };
  }, []);

  useEffect(() => {
    if (state?.kind === "recording" || !interactiveRef.current) return;
    interactiveRef.current = false;
    setDictationOverlayInteractive(false);
  }, [state?.kind]);

  if (!state) {
    return null;
  }

  const transcription =
    state.kind === "recording" ? state.transcription.trim() : "";
  const audioLevel = state.kind === "recording" ? (state.audioLevel ?? 0) : 0;
  const setInteractive = (interactive: boolean) => {
    if (interactiveRef.current === interactive) return;
    interactiveRef.current = interactive;
    setDictationOverlayInteractive(interactive);
  };
  const updateInteractionFromPointer = (
    event: MouseEvent<HTMLDivElement>,
  ) => {
    if (state.kind !== "recording") {
      setInteractive(false);
      return;
    }
    const button = stopButtonRef.current;
    if (!button) {
      setInteractive(false);
      return;
    }
    const rect = button.getBoundingClientRect();
    setInteractive(
      event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom,
    );
  };
  const stopRecording = () => {
    requestDictationOverlayStop();
    setInteractive(false);
  };

  return (
    <div
      className="flex h-screen w-screen items-start justify-center bg-transparent p-4"
      onMouseMove={updateInteractionFromPointer}
      onMouseLeave={() => setInteractive(false)}
    >
      <div className="flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-1 rounded-xl border border-[var(--border-default)] bg-[var(--surface-base)] px-4 py-2.5 shadow-lg">
        <div className="flex min-w-0 items-center gap-2">
          <StateIcon state={state} />
          <span className="truncate text-[11px] font-medium text-[var(--content-secondary)]">
            {stateLabel(state)}
          </span>
          {state.kind === "recording" && (
            <RecordingActions
              level={audioLevel}
              stopButtonRef={stopButtonRef}
              onInteractiveChange={setInteractive}
              onStop={stopRecording}
            />
          )}
        </div>
        {transcription && (
          // Bottom-anchored two-line text: the transcript grows as words
          // stream in and the newest words are the ones worth showing — a
          // line-clamp would freeze on the first two lines instead.
          <div className="flex max-h-7 flex-col justify-end overflow-hidden">
            <p className="break-words text-[10px] leading-snug text-[var(--content-tertiary)]">
              {transcription}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function RecordingActions({
  level,
  stopButtonRef,
  onInteractiveChange,
  onStop,
}: {
  level: number;
  stopButtonRef: RefObject<HTMLButtonElement | null>;
  onInteractiveChange: (interactive: boolean) => void;
  onStop: () => void;
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      <AudioMeter level={level} />
      <button
        ref={stopButtonRef}
        type="button"
        className="flex size-5 items-center justify-center rounded-full text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-overlay)] hover:text-[var(--system-negative-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--system-negative-strong)]"
        aria-label="Stop recording"
        title="Stop recording"
        onMouseEnter={() => onInteractiveChange(true)}
        onMouseLeave={() => onInteractiveChange(false)}
        onFocus={() => onInteractiveChange(true)}
        onBlur={() => onInteractiveChange(false)}
        onClick={onStop}
      >
        <StopCircle className="size-4" strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}

function AudioMeter({ level }: { level: number }) {
  const clamped = Math.max(0, Math.min(1, level));

  return (
    <div
      className="flex h-4 w-16 shrink-0 items-end gap-0.5"
      aria-hidden
    >
      {[0.16, 0.32, 0.48, 0.64, 0.8, 0.96].map((threshold, index) => (
        <span
          key={threshold}
          className="w-1 rounded-full bg-[var(--system-negative-strong)] transition-[height,opacity] duration-75"
          style={{
            height: `${6 + index * 1.5}px`,
            opacity: clamped >= threshold ? 1 : 0.22,
          }}
        />
      ))}
    </div>
  );
}

function stateLabel(state: DictationOverlayState): string {
  switch (state.kind) {
    case "recording":
      return "Recording…";
    case "processing":
      return "Processing…";
    case "done":
      return "Done";
    case "error":
      return state.message;
  }
}

function StateIcon({ state }: { state: DictationOverlayState }) {
  switch (state.kind) {
    case "recording":
      return (
        <span
          className="size-2 shrink-0 rounded-full bg-[var(--system-negative-strong)]"
          aria-hidden
        />
      );
    case "processing":
      return (
        <Loader2
          className="size-4 shrink-0 animate-spin text-[var(--content-secondary)]"
          aria-hidden
        />
      );
    case "done":
      return (
        <Check
          className="size-4 shrink-0 text-[var(--system-positive-strong)]"
          aria-hidden
        />
      );
    case "error":
      return (
        <TriangleAlert
          className="size-4 shrink-0 text-[var(--system-negative-strong)]"
          aria-hidden
        />
      );
  }
}
