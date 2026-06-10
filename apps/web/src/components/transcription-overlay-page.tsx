import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  dismissTranscriptionOverlay,
  getTranscriptionOverlayState,
  subscribeToTranscriptionOverlayState,
} from "@/runtime/transcription-overlay";
import type { TranscriptionOverlayState } from "@/runtime/is-electron";

/**
 * Transparent standalone page rendered inside the Electron transcription
 * overlay BrowserWindow. Main owns placement and visibility; this page renders
 * the latest transcript plus an explicit close affordance.
 */
export function TranscriptionOverlayPage() {
  const [state, setState] = useState<TranscriptionOverlayState | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToTranscriptionOverlayState(setState);
    void getTranscriptionOverlayState().then((initial) => {
      if (initial) {
        setState((current) => current ?? initial);
      }
    });
    return unsubscribe;
  }, []);

  const dismiss = useCallback(() => {
    void dismissTranscriptionOverlay();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [dismiss]);

  if (!state) {
    return null;
  }

  return (
    <div className="flex h-screen w-screen items-end justify-center bg-transparent p-3">
      <section
        aria-label="Transcription"
        aria-live="polite"
        className="flex max-h-full w-full max-w-[496px] items-start gap-3 overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--surface-base)] px-4 py-3 shadow-lg [-webkit-app-region:drag]"
      >
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-5 text-[var(--content-default)]">
          {state.transcript}
        </p>
        <button
          type="button"
          aria-label="Close transcription"
          title="Close"
          onClick={dismiss}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)] [-webkit-app-region:no-drag]"
        >
          <X size={16} aria-hidden />
        </button>
      </section>
    </div>
  );
}
