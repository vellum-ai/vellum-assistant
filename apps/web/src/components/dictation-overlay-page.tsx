import { Check, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getDictationOverlayState,
  subscribeToDictationOverlayState,
} from "@/runtime/dictation-overlay";
import type { DictationOverlayState } from "@/runtime/is-electron";

/**
 * Live dictation pill rendered inside the Electron dictation overlay
 * BrowserWindow — a click-through, non-activating panel pinned top-center
 * of the active display while the user dictates via push-to-talk into
 * another app. The Electron port of the native Swift client's
 * `DictationOverlayWindow`: a status row (state icon + label) over an
 * optional two-line live transcription that expands the pill as words
 * stream in.
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

  return (
    <div className="flex h-screen w-screen items-start justify-center bg-transparent p-4">
      <div className="flex min-w-40 max-w-full flex-col gap-1 rounded-xl border border-[var(--border-default)] bg-[var(--surface-base)] px-4 py-2.5 shadow-lg">
        <div className="flex items-center gap-2">
          <StateIcon state={state} />
          <span className="truncate text-[11px] font-medium text-[var(--content-secondary)]">
            {stateLabel(state)}
          </span>
        </div>
        {transcription && (
          <p className="line-clamp-2 break-words text-[10px] leading-snug text-[var(--content-tertiary)]">
            {transcription}
          </p>
        )}
      </div>
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
