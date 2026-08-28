/**
 * Live-voice session surface for when the session is off its own conversation
 * (Light 736 desktop, Light 743 mobile). Presentational: the mounting host
 * owns store wiring and visibility rules.
 *
 * It carries the minimized composer block's treatment at pill scale: painted in
 * the room's own background color, the mesh band filling it, and the controls
 * quiet at the edges. Room, minimized block and pill are then one surface at
 * three sizes, so a session moving between them reads as the same thing
 * resizing rather than three different widgets.
 *
 * The band is the whole readout, inked the way the room inks its two: the user
 * lifts a pale sheet off the floor while the mic is live, the assistant answers
 * in a darker one, and in silence the floor is empty. Nothing is painted over
 * it, so the surface says what it is doing by moving; the state string reaches
 * assistive tech through an `sr-only` live region instead.
 *
 * Two layouts:
 *
 * - `"pill"`: an elongated pill in the header's right cluster. Height is
 *   capped at `h-8` (32px), because the header's Electron title-bar row is 44px
 *   min-height with 32px controls, so the pill must never stretch it.
 * - `"row"`: the same pill stretched edge to edge above the thread header on a
 *   phone, where the header has no width to give. It keeps the pill's radius
 *   rather than squaring off into a band, so the two layouts read as one shape
 *   at two widths. It is laid out in flow and pushes the page down rather than
 *   overlaying it, so a live session hides nothing.
 *
 * The paint arrives as a prop rather than being resolved here: the fill is an
 * arbitrary avatar color, so chrome on it reads the `--room-*` vars the paint
 * publishes instead of theme tokens (see `voice-surface-paint.ts`). Until the
 * avatar query settles there is no paint and the surface holds `--surface-lift`,
 * so it changes color once instead of flashing through the ambient dark.
 *
 * The middle of the surface carries the return-to-thread tap: the largest
 * target for the most likely action. It is a `button` only when `onNavigate` is
 * supplied: a session not yet attached to a conversation has nowhere to go, so
 * the surface never ships a dead target.
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

import type { CSSProperties } from "react";

import { Mic, MicOff, TriangleAlert, Volume2, VolumeX, X } from "lucide-react";

import { Button, Tag, cn } from "@vellumai/design-library";

import {
  isLiveVoiceMicLive,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { VOICE_WAVE_EDGE_FADE_CLASS } from "@/domains/chat/voice/voice-room/voice-listening-waves";
import { BAND_VOICE } from "@/domains/chat/voice/voice-room/voice-room-eyes";
import {
  MESH_INLINE_TUNING,
  VoiceMeshWaves,
} from "@/domains/chat/voice/voice-room/voice-mesh-waves";
import {
  VOICE_SURFACE_CONTROL_CLASS,
  voiceSurfaceMutedInk,
  voiceSurfaceStyle,
  voiceSurfaceTheme,
  type VoiceSurfacePaint,
} from "@/domains/chat/voice/voice-room/voice-surface-paint";
import { useTranslation } from "@/i18n";

// While the mic is not live (muted, assistant speaking) the band reads a
// steady zero and settles into its quiet drift, the room's own resting
// listening state, instead of freezing.
const SILENT_AMPLITUDE = () => 0;

/**
 * Pill width. Wide enough for the band to read as a band between the two
 * control clusters, narrow enough that the header's centre title keeps a
 * readable share of the row (the centre zone is the only one that gives, see
 * `ChatLayoutHeader`).
 */
const PILL_WIDTH_CLASS = "w-56";

/**
 * Breathing room either side of the header pill. The right cluster's own
 * `gap-2` is tuned for icon buttons, and a painted 224px capsule pressed that
 * close reads as jammed between the centre title and the search button. This
 * takes the separation to 16px on the trailing side and holds the title off
 * the leading cap.
 */
const PILL_MARGIN_CLASS = "mx-2";

/**
 * Pill height on a phone: a 44px row clears the touch target the controls want.
 * The radius follows the height (`rounded-full`), so the caps are 22px and the
 * row keeps its `px-3` inset to hold the outer glyphs clear of that curve.
 */
const ROW_HEIGHT_CLASS = "h-11";

export interface VoiceSessionPillProps {
  /**
   * The session's activity label (e.g. "Listening…", resolved by the host
   * from `liveVoiceSurfaceLabelKey`). Not painted: announced to assistive tech
   * through an `sr-only` live region, since the surface is wordless.
   */
  primaryLabel: string;
  state: LiveVoiceSessionState;
  /** Polled by the band at ~30 Hz; must not force parent re-renders. */
  getAmplitude: () => number;
  /**
   * Assistant-playback level, same polling contract. The band rides this while
   * the assistant speaks, so the surface keeps moving through the half of the
   * turn the mic is silent for, exactly as the room's two bands do.
   */
  getOutputAmplitude: () => number;
  /** Whether the mic is muted. Drives the mic toggle beside the band. */
  muted: boolean;
  /** Toggle the mic mute without ending the session. */
  onToggleMute: () => void;
  /** Whether the assistant's audio is muted. Drives the right-side toggle. */
  outputMuted: boolean;
  /**
   * Mute (or unmute) the assistant without ending the session or stopping the
   * reply. The turn keeps running and the transcript keeps filling, so
   * unmuting drops the user back in wherever it has reached.
   */
  onToggleOutputMute: () => void;
  /** End the voice session. */
  onEnd: () => void;
  /**
   * Navigate to the owning thread. Turns the band's middle into the tap
   * target; omitted when the session has no conversation to return to, leaving
   * that area inert rather than a dead button.
   */
  onNavigate?: () => void;
  /**
   * The room's fill and its foreground tones. Null until the session
   * assistant's avatar resolves, which is when the surface holds the app's own
   * lift surface instead.
   */
  paint?: VoiceSurfacePaint | null;
  /**
   * `"pill"` (default) for the header's right cluster, `"row"` for the same
   * pill stretched edge to edge above a phone's thread header.
   */
  layout?: "pill" | "row";
}

export function VoiceSessionPill({
  primaryLabel,
  state,
  getAmplitude,
  getOutputAmplitude,
  muted,
  onToggleMute,
  outputMuted,
  onToggleOutputMute,
  onEnd,
  onNavigate,
  paint = null,
  layout = "pill",
}: VoiceSessionPillProps) {
  const { t } = useTranslation("chat");
  const isRow = layout === "row";
  const label = muted ? "Muted" : primaryLabel;
  const iconClass = isRow ? "size-4" : "size-3.5";

  // Which voice the band draws, in the room's own terms: the user lifts a pale
  // sheet off the floor, the assistant answers in a darker one, and in silence
  // the floor is empty. The ink cannot be the avatar accent, which is what the
  // surface is painted with: a band in the fill's own hue paints nothing.
  //
  // The reply wins the surface while it plays. The mic stays open through it
  // for barge-in (`isLiveVoiceMicLive` spans listening to speaking), so keying
  // off the mic alone would draw the user's voice over the assistant's.
  const replying = state === "speaking";
  const micLive = isLiveVoiceMicLive(state) && !muted;
  const ink = replying ? BAND_VOICE.responding : BAND_VOICE.listening;

  // A muted control has to stay visible on the fill it sits on, so "off" is a
  // red chosen against that fill rather than the theme's negative token.
  const mutedInk = {
    "--vbtn-fg": voiceSurfaceMutedInk(paint),
  } as CSSProperties;

  // The band fills the whole surface rather than sitting in a column of its
  // own, so the color and the motion read as one thing. It sits behind the
  // controls, which is why it is first and inert.
  const band = (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        VOICE_WAVE_EDGE_FADE_CLASS,
      )}
    >
      <VoiceMeshWaves
        getAmplitude={
          replying
            ? getOutputAmplitude
            : micLive
              ? getAmplitude
              : SILENT_AMPLITUDE
        }
        color={ink.color}
        peakOpacity={ink.peakOpacity}
        placement="inline"
        tuning={{ ...MESH_INLINE_TUNING, opacityKnee: ink.opacityKnee }}
      />
    </div>
  );

  return (
    <div
      role="group"
      aria-label={t("voiceSessionPill.groupAria")}
      data-theme={voiceSurfaceTheme(paint)}
      style={paint ? voiceSurfaceStyle(paint) : undefined}
      className={cn(
        "relative flex items-center gap-1 overflow-hidden rounded-full transition-colors duration-300 [-webkit-app-region:no-drag]",
        isRow
          ? `w-full shrink-0 px-3 ${ROW_HEIGHT_CLASS}`
          : `h-8 px-1 ${PILL_WIDTH_CLASS} ${PILL_MARGIN_CLASS}`,
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
        aria-label={muted ? t("voiceSessionPill.unmuteMic") : t("voiceSessionPill.muteMic")}
        aria-pressed={muted}
        tooltip={muted ? t("voiceSessionPill.unmuteMic") : t("voiceSessionPill.muteMic")}
        className={cn("relative", VOICE_SURFACE_CONTROL_CLASS)}
        style={muted ? mutedInk : undefined}
      />

      {/* The middle of the surface is the band and nothing else, and it is the
          largest target, so it carries the return-to-thread tap. A `button`
          only when there is a thread to return to, so the surface never ships
          a dead target. */}
      {onNavigate ? (
        <button
          type="button"
          onClick={onNavigate}
          aria-label={t("voiceSessionPill.goToThreadAria")}
          className="relative min-w-0 flex-1 cursor-pointer self-stretch rounded-full hover:bg-[var(--room-wash,var(--surface-hover))]"
        />
      ) : (
        <div className="relative min-w-0 flex-1" />
      )}

      {/* The surface paints no words, so the state reaches assistive tech
          here. Announced on change, like the minimized block's. */}
      <span aria-live="polite" className="sr-only">
        {label}
      </span>

      <div className="relative flex shrink-0 items-center gap-1">
        {/* Mute the assistant, the room's own pairing for the mic mute: one
            control per direction of the conversation, both persistent, so
            neither moves out from under a reaching finger mid-turn. */}
        <Button
          variant="ghost"
          iconOnly={
            outputMuted ? (
              <VolumeX className={iconClass} />
            ) : (
              <Volume2 className={iconClass} />
            )
          }
          expandOnMobile={isRow}
          aria-label={outputMuted ? t("voiceSessionPill.unmuteAssistant") : t("voiceSessionPill.muteAssistant")}
          aria-pressed={outputMuted}
          tooltip={outputMuted ? t("voiceSessionPill.unmuteAssistant") : t("voiceSessionPill.muteAssistant")}
          onClick={onToggleOutputMute}
          className={cn("relative", VOICE_SURFACE_CONTROL_CLASS)}
          style={outputMuted ? mutedInk : undefined}
        />
        <Button
          variant="ghost"
          iconOnly={<X className={iconClass} strokeWidth={2.5} />}
          expandOnMobile={isRow}
          aria-label={t("voiceSessionPill.endSession")}
          tooltip={t("voiceSessionPill.endSession")}
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
  const { t } = useTranslation("chat");
  return (
    <Tag
      role="alert"
      tone="negative"
      leftIcon={<TriangleAlert />}
      onRemove={onDismiss}
      removeLabel={t("voiceSessionPill.dismiss")}
      className="h-8 max-w-80 gap-2 rounded-full border border-[color-mix(in_srgb,var(--system-negative-strong)_25%,transparent)] py-1 pl-3 pr-1.5 [-webkit-app-region:no-drag]"
    >
      <span className="min-w-0 truncate" title={message}>
        {message}
      </span>
    </Tag>
  );
}
