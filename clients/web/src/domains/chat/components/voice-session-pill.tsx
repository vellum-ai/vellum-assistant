/**
 * Title-bar pill for an active live-voice session (Light 54's right cluster).
 * Presentational — the mounting host owns store wiring and visibility rules.
 *
 * Layout, left → right: two-line context label (primary action text over the
 * owning thread's name), optional circular stop control (only when the host
 * provides `onStop` and the assistant is `speaking`), mic glyph + compact
 * timeline waveform, red ✕ (end session), green ↑ (manual turn release —
 * enabled only while `listening`).
 *
 * The pill lives inside `ChatLayoutHeader`, which doubles as the Electron
 * macOS title bar (`-webkit-app-region: drag`). The root opts the whole
 * cluster out via `no-drag` so every child — including the non-`button`
 * canvas/label area — stays clickable, matching the header's own treatment of
 * its interactive children.
 *
 * Height is capped at `h-8` (32px): the header's Electron title-bar row is
 * 44px min-height with 32px controls, so the pill must never stretch it.
 */

import { ArrowUp, Mic, Square, TriangleAlert, X } from "lucide-react";

import { Button, Typography, cn } from "@vellumai/design-library";

import {
  isLiveVoiceMicLive,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { VoiceTimelineWaveform } from "@/domains/chat/voice/voice-timeline-waveform";

export interface VoiceSessionPillProps {
  /**
   * Line 1: the session's activity label (e.g. "Listening…" — see
   * `LIVE_VOICE_STATE_LABELS`).
   */
  primaryLabel: string;
  /** Line 2: the owning thread's name. */
  secondaryLabel?: string;
  state: LiveVoiceSessionState;
  /** Polled by the waveform at ~30 Hz; must not force parent re-renders. */
  getAmplitude: () => number;
  /**
   * Stop the in-flight assistant response without ending the session. The
   * ■ control is hidden when absent — hosts must only wire this once a
   * turn-scoped interrupt exists; the ✕ (`onEnd`) is the destructive control.
   * Dormant until the turn-scoped interrupt lands (engine plan, JARVIS-1240):
   * no host passes it yet, deliberately.
   */
  onStop?: () => void;
  /** End the voice session. */
  onEnd: () => void;
  /** Manual turn release ("send now") while listening. */
  onSend: () => void;
  /** Invoked when the label area is clicked (navigate to the owning thread). */
  onNavigate?: () => void;
}

export function VoiceSessionPill({
  primaryLabel,
  secondaryLabel,
  state,
  getAmplitude,
  onStop,
  onEnd,
  onSend,
  onNavigate,
}: VoiceSessionPillProps) {
  const labelContent = (
    <>
      <Typography
        as="p"
        variant="body-medium-default"
        className="truncate text-[var(--content-default)]"
      >
        {primaryLabel}
      </Typography>
      {secondaryLabel ? (
        <Typography
          as="p"
          variant="label-medium-default"
          className="truncate text-[var(--content-tertiary)]"
        >
          {secondaryLabel}
        </Typography>
      ) : null}
    </>
  );

  // Right-aligned per Light 54: both lines rag toward the stop control.
  const labelClass = "flex h-8 min-w-0 max-w-40 flex-col justify-center gap-0.5 text-right";

  return (
    <div
      role="group"
      aria-label="Voice session"
      className="flex h-8 items-center gap-2 [-webkit-app-region:no-drag]"
    >
      {onNavigate ? (
        <button
          type="button"
          onClick={onNavigate}
          aria-label="Go to voice session thread"
          className={cn(labelClass, "cursor-pointer")}
        >
          {labelContent}
        </button>
      ) : (
        <div className={labelClass}>{labelContent}</div>
      )}
      {onStop && state === "speaking" ? (
        <Button
          variant="primary"
          iconOnly={<Square fill="currentColor" />}
          className="rounded-full"
          // Compact title-bar affordance: keep desktop sizing so the pill
          // never exceeds the header row height on touch-mobile web.
          expandOnMobile={false}
          aria-label="Stop assistant response"
          tooltip="Stop assistant response"
          onClick={onStop}
        />
      ) : null}
      <div className="flex items-center gap-1">
        <Mic aria-hidden className="size-3.5 shrink-0 text-[var(--content-default)]" />
        <VoiceTimelineWaveform
          compact
          active={isLiveVoiceMicLive(state)}
          getAmplitude={getAmplitude}
          className="w-24"
        />
      </div>
      <Button
        variant="danger"
        iconOnly={<X strokeWidth={2.5} />}
        className="rounded-full"
        expandOnMobile={false}
        aria-label="End voice session"
        tooltip="End voice session"
        onClick={onEnd}
      />
      <Button
        variant="primary"
        iconOnly={<ArrowUp strokeWidth={2.5} />}
        className="rounded-full"
        expandOnMobile={false}
        disabled={state !== "listening"}
        aria-label="Send now"
        tooltip="Send now"
        onClick={onSend}
      />
    </div>
  );
}

export interface VoiceSessionErrorChipProps {
  /** Failure message from the live-voice store (`error` when `failed`). */
  message: string;
  /** Dismiss the failure (host resets the store back to idle). */
  onDismiss: () => void;
}

/**
 * Compact failed-session chip rendered in the pill's slot when a session
 * fails while no composer (and thus no composer failure `Notice`) is on
 * screen — Home, Library, the inspector, the fullscreen app viewer. Same
 * height budget as the pill (`h-8`, title-bar safe), error tone tokens per
 * the design-library `Notice` error treatment.
 */
export function VoiceSessionErrorChip({
  message,
  onDismiss,
}: VoiceSessionErrorChipProps) {
  return (
    <div
      role="alert"
      className="flex h-8 max-w-80 items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--system-negative-strong)_25%,transparent)] bg-[var(--system-negative-weak)] py-1 pl-3 pr-1.5 [-webkit-app-region:no-drag]"
    >
      <TriangleAlert
        aria-hidden
        className="size-3.5 shrink-0 text-[color:var(--system-negative-strong)]"
      />
      <Typography
        as="p"
        variant="label-medium-default"
        className="truncate text-[var(--content-default)]"
        title={message}
      >
        {message}
      </Typography>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 cursor-pointer rounded-full p-0.5 text-[color:var(--content-secondary)] opacity-70 transition-opacity hover:opacity-100"
      >
        <X aria-hidden className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
