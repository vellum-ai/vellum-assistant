/**
 * Live transcript and status surface for the live voice mode.
 *
 * Renders an absolute-positioned overlay above the composer while a
 * live voice session is in progress. Mirrors the macOS
 * `VoiceTranscriptionWindow` / `VoiceModeManager.stateLabel` surface
 * (`clients/macos/.../Features/Voice/VoiceTranscriptionWindow.swift`)
 * so the web and native clients show the same status, amplitude, and
 * transcript hierarchy during a live session.
 *
 * State is read from `useLiveVoiceStore` via atomic per-field selectors
 * so unrelated mutations (e.g. amplitude updates flowing at audio rate)
 * don't re-render the entire overlay.
 *
 * Returns `null` when the live voice state is `off`.
 *
 * @see https://zustand.docs.pmnd.rs/guides/auto-generating-selectors
 */

import { cn } from "@vellum/design-library";

import {
  type LiveVoiceState,
  useLiveVoiceStore,
} from "@/domains/voice/live-voice/live-voice-store";

/**
 * User-facing label for each live voice lifecycle state. Mirrors the
 * macOS `VoiceModeManager.stateLabel` switch. `off` is present so the
 * lookup is total — callers gate rendering by checking `state === "off"`
 * before selecting a label.
 */
const STATE_LABELS: Record<LiveVoiceState, string> = {
  off: "",
  connecting: "Connecting…",
  listening: "Listening…",
  transcribing: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  ending: "Ending…",
  failed: "Connection failed",
};

interface LiveVoiceOverlayProps {
  className?: string;
}

export function LiveVoiceOverlay({ className }: LiveVoiceOverlayProps) {
  const state = useLiveVoiceStore.use.state();
  const partialTranscript = useLiveVoiceStore.use.partialTranscript();
  const finalTranscript = useLiveVoiceStore.use.finalTranscript();
  const assistantTranscript = useLiveVoiceStore.use.assistantTranscript();
  const inputAmplitude = useLiveVoiceStore.use.inputAmplitude();
  const errorMessage = useLiveVoiceStore.use.errorMessage();

  if (state === "off") return null;

  // Defend against out-of-range amplitudes so the bar can't overflow.
  const amplitudePct = Math.max(0, Math.min(1, inputAmplitude)) * 100;
  const isFailed = state === "failed";

  return (
    <div
      data-slot="live-voice-overlay"
      data-state={state}
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-full mb-2 flex flex-col gap-2 rounded-lg border border-[var(--border-element)] bg-[var(--surface-overlay)] p-3 shadow-[var(--shadow-popover)]",
        className,
      )}
    >
      <div
        data-slot="live-voice-overlay-status"
        className="text-body-small-emphasised text-[var(--content-default)]"
      >
        {STATE_LABELS[state]}
      </div>

      <div
        data-slot="live-voice-overlay-amplitude"
        className="h-1 w-full overflow-hidden rounded-full bg-[var(--surface-active)]"
        aria-hidden="true"
      >
        <div
          data-slot="live-voice-overlay-amplitude-fill"
          className="h-full bg-[var(--primary-base)] transition-[width] duration-75 ease-out"
          style={{ width: `${amplitudePct}%` }}
        />
      </div>

      {(partialTranscript || finalTranscript) && (
        <div
          data-slot="live-voice-overlay-transcript"
          className="max-h-32 overflow-y-auto text-body-medium-default text-[var(--content-default)]"
        >
          {finalTranscript && <span>{finalTranscript}</span>}
          {finalTranscript && partialTranscript ? " " : null}
          {partialTranscript && (
            <span
              data-slot="live-voice-overlay-partial"
              className="text-[var(--content-secondary)]"
            >
              {partialTranscript}
            </span>
          )}
        </div>
      )}

      {assistantTranscript && (
        <div
          data-slot="live-voice-overlay-assistant"
          className="max-h-32 overflow-y-auto text-body-medium-lighter italic text-[var(--content-tertiary)]"
        >
          {assistantTranscript}
        </div>
      )}

      {isFailed && errorMessage && (
        <div
          data-slot="live-voice-overlay-error"
          role="alert"
          className="text-body-small-default text-[var(--system-negative-strong)]"
        >
          {errorMessage}
        </div>
      )}
    </div>
  );
}
