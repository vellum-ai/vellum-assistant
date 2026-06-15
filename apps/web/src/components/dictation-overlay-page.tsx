import { Check, Loader2, Square, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

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
 * Electron port of the native Swift client's `DictationOverlayWindow`: a
 * status row (stop button + label, with the state icon and compact audio
 * meter on the right edge) and optional two-line live transcription. The
 * window is click-through except while the cursor hovers the stop button.
 *
 * Standalone (no auth, no RootLayout) like the Quick Input page; the
 * window canvas is transparent, so the page paints only the pill. The
 * main process owns visibility — this page just renders the latest state
 * it receives. Off-Electron the subscription no-ops and the page stays
 * blank.
 */
export function DictationOverlayPage() {
  const [state, setState] = useState<DictationOverlayState | null>(null);

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

  if (!state) {
    return null;
  }

  const transcription =
    state.kind === "recording" ? state.transcription.trim() : "";
  const audioLevel = state.kind === "recording" ? (state.audioLevel ?? 0) : 0;

  return (
    <div className="flex h-screen w-screen items-start justify-center bg-transparent p-4">
      <div className="flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-1 rounded-xl border border-[var(--border-default)] bg-[var(--surface-base)] px-4 py-2.5 shadow-lg">
        <div className="flex min-w-0 items-center gap-2">
          {(state.kind === "recording" || state.kind === "processing") && (
            <StopButton processing={state.kind === "processing"} />
          )}
          <span className="truncate text-[11px] font-medium text-[var(--content-secondary)]">
            {stateLabel(state)}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {state.kind === "recording" && <AudioMeter level={audioLevel} />}
            <StateIcon state={state} />
          </div>
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

/**
 * Stop control shown while a session can still be ended: during recording
 * it stops the capture and hands the audio to transcription; during
 * processing it abandons the in-flight transcription.
 *
 * The overlay window is click-through, so the button is only clickable via
 * the forwarded-mousemove hover pattern: mouseenter flips the window
 * interactive, mouseleave (or unmount, when the session reaches a terminal
 * state under the cursor) flips it back.
 */
function StopButton({ processing }: { processing: boolean }) {
  useEffect(() => () => setDictationOverlayInteractive(false), []);

  const label = processing ? "Cancel transcription" : "Stop dictation";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[var(--border-default)] text-[var(--system-negative-strong)] transition-colors hover:bg-[var(--surface-hover)]"
      onMouseEnter={() => setDictationOverlayInteractive(true)}
      onMouseLeave={() => setDictationOverlayInteractive(false)}
      onClick={() => requestDictationOverlayStop()}
    >
      <Square className="size-2 fill-current" aria-hidden />
    </button>
  );
}

function AudioMeter({ level }: { level: number }) {
  const clamped = Math.max(0, Math.min(1, level));

  return (
    <div className="flex h-4 w-16 shrink-0 items-end gap-0.5" aria-hidden>
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
