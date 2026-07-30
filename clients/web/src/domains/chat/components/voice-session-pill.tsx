/**
 * Live-voice session surface for when the session is off its own conversation
 * (Light 736 desktop, Light 743 mobile). Presentational: the mounting host
 * owns store wiring and visibility rules.
 *
 * It carries the minimized composer block's treatment at pill scale: painted in
 * the room's own background color, the mesh band filling it, the state word in
 * the middle, and the controls quiet at the edges. Room, minimized block and
 * pill are then one surface at three sizes, so a session moving between them
 * reads as the same thing resizing rather than three different widgets.
 *
 * Two layouts:
 *
 * - `"pill"`: an elongated pill in the header's right cluster. Height is
 *   capped at `h-8` (32px), because the header's Electron title-bar row is 44px
 *   min-height with 32px controls, so the pill must never stretch it.
 * - `"row"`: a full-bleed band above the thread header on a phone, where the
 *   header has no width to give. It is laid out in flow and pushes the page
 *   down rather than overlaying it, so a live session hides nothing.
 *
 * The paint arrives as a prop rather than being resolved here: the fill is an
 * arbitrary avatar color, so chrome on it reads the `--room-*` vars the paint
 * publishes instead of theme tokens (see `voice-surface-paint.ts`). Until the
 * avatar query settles there is no paint and the surface holds `--surface-lift`,
 * so it changes color once instead of flashing through the ambient dark.
 *
 * The state word is the middle of the surface and carries the return-to-thread
 * tap: the largest target for the most likely action. It is a `button` only
 * when `onNavigate` is supplied: a session not yet attached to a conversation
 * has nowhere to go, so the surface never ships a dead target.
 *
 * Controls are the same quiet pair the minimized block uses, one per edge: mute
 * the mic on the left, and on the right the stop slot (■, present only while a
 * reply is playing) and end. Neither layout offers a manual "send now": turns
 * release themselves (server VAD hands-free, auto-release in the manual
 * fallback), so a persistent send would advertise an action the user never
 * needs to take. ■ earns its place because interrupting a reply in progress has
 * no silent equivalent.
 *
 * The pill layout lives inside `ChatLayoutHeader`, which doubles as the
 * Electron macOS title bar (`-webkit-app-region: drag`). The root opts the
 * whole surface out via `no-drag` so every child (including the inert band)
 * stays clickable, matching the header's own treatment of its interactive
 * children.
 */

import { Mic, MicOff, Square, TriangleAlert, X } from "lucide-react";

import { Button, Tag, cn } from "@vellumai/design-library";

import {
  isLiveVoiceMicLive,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { VOICE_WAVE_EDGE_FADE_CLASS } from "@/domains/chat/voice/voice-room/voice-listening-waves";
import {
  MESH_INLINE_TUNING,
  VoiceMeshWaves,
} from "@/domains/chat/voice/voice-room/voice-mesh-waves";
import {
  VOICE_SURFACE_CONTROL_CLASS,
  voiceSurfaceStyle,
  voiceSurfaceTheme,
  type VoiceSurfacePaint,
} from "@/domains/chat/voice/voice-room/voice-surface-paint";

// While the mic is not live (muted, assistant speaking) the band reads a
// steady zero and settles into its quiet drift, the room's own resting
// listening state, instead of freezing.
const SILENT_AMPLITUDE = () => 0;

/**
 * Pill width. Wide enough for the state word between the two control clusters,
 * narrow enough that the header's centre title keeps a readable share of the
 * row (the centre zone is the only one that gives, see `ChatLayoutHeader`).
 */
const PILL_WIDTH_CLASS = "w-56";

/** Band height on a phone: a 44px row clears the touch target the controls want. */
const ROW_HEIGHT_CLASS = "h-11";

export interface VoiceSessionPillProps {
  /**
   * The session's activity label (e.g. "Listening…", see
   * `LIVE_VOICE_STATE_LABELS`). Painted in the middle of the surface, and
   * announced on change: the label element is itself the live region.
   */
  primaryLabel: string;
  state: LiveVoiceSessionState;
  /** Polled by the band at ~30 Hz; must not force parent re-renders. */
  getAmplitude: () => number;
  /** Whether the mic is muted. Drives the mic toggle beside the band. */
  muted: boolean;
  /** Toggle the mic mute without ending the session. */
  onToggleMute: () => void;
  /**
   * Stop the in-flight assistant response without ending the session. The
   * ■ control occupies the stop slot only while `speaking`, and is hidden
   * when absent — the host wires it only for hands-free sessions, where the
   * interrupt is turn-scoped; a manual session's interrupt ends the whole
   * session, so there the ✕ (`onEnd`) is the only stop.
   */
  onStop?: () => void;
  /** End the voice session. */
  onEnd: () => void;
  /**
   * Navigate to the owning thread. Turns the state word into the tap target;
   * omitted when the session has no conversation to return to, leaving the
   * word inert rather than a dead button.
   */
  onNavigate?: () => void;
  /**
   * Accent hex matching the avatar the voice room renders (see
   * `resolveWaveAccentHex`), so the band keeps the room's tint.
   * Null/omitted falls back to the app-wide accent, then aurora.
   */
  waveAccentHex?: string | null;
  /**
   * The room's fill and its foreground tones. Null until the session
   * assistant's avatar resolves, which is when the surface holds the app's own
   * lift surface instead.
   */
  paint?: VoiceSurfacePaint | null;
  /**
   * `"pill"` (default) for the header's right cluster, `"row"` for the
   * full-bleed band a phone shows above the thread header.
   */
  layout?: "pill" | "row";
}

export function VoiceSessionPill({
  primaryLabel,
  state,
  getAmplitude,
  muted,
  onToggleMute,
  onStop,
  onEnd,
  onNavigate,
  waveAccentHex,
  paint = null,
  layout = "pill",
}: VoiceSessionPillProps) {
  const isRow = layout === "row";
  const label = muted ? "Muted" : primaryLabel;
  const iconClass = isRow ? "size-4" : "size-3.5";

  // The band fills the whole surface rather than sitting in a column of its
  // own, so the color and the motion read as one thing. Behind the controls and
  // the state word, which is why it is first and inert.
  const band = (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        VOICE_WAVE_EDGE_FADE_CLASS,
      )}
    >
      {/* The accent goes through `color`, not the CSS var: the mesh reads the
          var once at mount and again only on resize, so a pill mounted before
          the avatar query settles would hold the fallback indigo for the whole
          session. `color` is a dependency of the draw effect, so the band
          repaints the moment the accent arrives. */}
      <VoiceMeshWaves
        getAmplitude={
          isLiveVoiceMicLive(state) && !muted ? getAmplitude : SILENT_AMPLITUDE
        }
        palette="accent"
        color={waveAccentHex ?? undefined}
        placement="inline"
        tuning={MESH_INLINE_TUNING}
      />
    </div>
  );

  // The state word doubles as the live region: one node, so a screen reader
  // announces the state once per change rather than reading a visible copy and
  // an `sr-only` one.
  const stateWord = (
    <span
      aria-live="polite"
      className="truncate text-sm font-medium text-[var(--room-fg-muted,var(--content-secondary))]"
    >
      {label}
    </span>
  );

  return (
    <div
      role="group"
      aria-label="Voice session"
      data-theme={voiceSurfaceTheme(paint)}
      style={paint ? voiceSurfaceStyle(paint) : undefined}
      className={cn(
        "relative flex items-center gap-1 overflow-hidden transition-colors duration-300 [-webkit-app-region:no-drag]",
        isRow
          ? `w-full shrink-0 px-2 ${ROW_HEIGHT_CLASS}`
          : `h-8 rounded-full px-1 ${PILL_WIDTH_CLASS}`,
        // Until the avatar resolves there is no room color to paint, so the
        // surface holds the app's own raised surface.
        !paint && "bg-[var(--surface-lift)]",
      )}
    >
      {band}

      {/* The mic toggle: the one control a hot open mic must always offer,
          wherever the session surface is. */}
      <Button
        variant="ghost"
        iconOnly={
          muted ? (
            <MicOff className={iconClass} />
          ) : (
            <Mic className={iconClass} />
          )
        }
        // The pill sits in a 32px title-bar row, so it keeps desktop sizing
        // even on touch-mobile web; the row is tall enough for the 40px
        // touch chrome.
        expandOnMobile={isRow}
        onClick={onToggleMute}
        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={muted}
        tooltip={muted ? "Unmute microphone" : "Mute microphone"}
        className={cn(
          "relative",
          VOICE_SURFACE_CONTROL_CLASS,
          muted && "[--vbtn-fg:var(--system-negative-strong)]",
        )}
      />

      {/* The state word is the surface's largest target, so it carries the
          return-to-thread tap, and is a `button` only when there is a thread to
          return to. */}
      {onNavigate ? (
        <button
          type="button"
          onClick={onNavigate}
          aria-label="Go to voice session thread"
          className="relative flex min-w-0 flex-1 cursor-pointer items-center justify-center self-stretch rounded-full hover:bg-[var(--room-wash,var(--surface-hover))]"
        >
          {stateWord}
        </button>
      ) : (
        <div className="relative flex min-w-0 flex-1 items-center justify-center">
          {stateWord}
        </div>
      )}

      <div className="relative flex shrink-0 items-center gap-1">
        {/* Stop slot: ■ interrupts a reply in progress, and is present only
            while one is playing. Nothing occupies the slot otherwise. */}
        {onStop && state === "speaking" ? (
          <Button
            variant="ghost"
            iconOnly={<Square className={iconClass} fill="currentColor" />}
            expandOnMobile={isRow}
            aria-label="Stop assistant response"
            tooltip="Stop assistant response"
            onClick={onStop}
            className={cn("relative", VOICE_SURFACE_CONTROL_CLASS)}
          />
        ) : null}
        <Button
          variant="ghost"
          iconOnly={<X className={iconClass} strokeWidth={2.5} />}
          expandOnMobile={isRow}
          aria-label="End voice session"
          tooltip="End voice session"
          onClick={onEnd}
          className={cn("relative", VOICE_SURFACE_CONTROL_CLASS)}
        />
      </div>
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
 * screen — Home, Library, the inspector, the fullscreen app viewer. Composes
 * the design-library `Tag` in its dismissible-chip form (negative tone,
 * `onRemove`), overriding only what the title-bar slot demands: the pill's
 * `h-8` height budget, pill radius, a subtle negative border, and the
 * Electron `no-drag` opt-out.
 */
export function VoiceSessionErrorChip({
  message,
  onDismiss,
}: VoiceSessionErrorChipProps) {
  return (
    <Tag
      role="alert"
      tone="negative"
      leftIcon={<TriangleAlert />}
      onRemove={onDismiss}
      removeLabel="Dismiss"
      className="h-8 max-w-80 gap-2 rounded-full border border-[color-mix(in_srgb,var(--system-negative-strong)_25%,transparent)] py-1 pl-3 pr-1.5 [-webkit-app-region:no-drag]"
    >
      <span className="min-w-0 truncate" title={message}>
        {message}
      </span>
    </Tag>
  );
}
