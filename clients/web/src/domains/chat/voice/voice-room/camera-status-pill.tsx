/**
 * The readout floating at the top of the room while the camera is open: what
 * the camera is doing, and what the session is doing, in one mark.
 *
 * One pill rather than two indicators because the two answers are read
 * together. The room's usual state caption is suppressed while the viewfinder
 * is up (it sits in the middle of the frame, where the user is aiming), so
 * without this the only thing on screen saying the session is still listening
 * would be the mic button's absence of red. The dot carries the voice state and
 * the words carry the mode, which is why the mode word leads: it is the one
 * thing the camera chrome does not otherwise say.
 *
 * The second word is the session's whole surface label, not a two-way
 * Listening/Muted split. Because this pill is the only session readout on
 * screen while the viewfinder is up, a fixed "Listening" would tell the user
 * the mic is open through a connect, a reconnect, a teardown, and a failure,
 * none of which can take speech. The one substitution is the assistant's name
 * while it is audibly talking: it says everything "Speaking…" would, plus
 * whose voice it is.
 *
 * Photo is the only mode it renders, and it answers no press, so it is a status
 * region rather than a button.
 *
 * A configured assistant name is arbitrarily long, so the name is the one part
 * that gives way: it truncates to an ellipsis inside whatever width the room
 * allows the pill, leaving the dot and the mode word whole. The announcement
 * keeps the name in full, since a screen reader has no width to run out of.
 *
 * Presentational: the room derives the voice state, resolves the label, and
 * owns the assistant identity, so nothing here reaches for a store and the
 * whole state matrix is reachable from props.
 */

import { cn } from "@vellumai/design-library";
import { useReducedMotion } from "motion/react";

import { useTranslation } from "@/i18n";

import { cameraModeStyle } from "./camera-mode-paint";
import type { CameraVoiceState } from "./use-camera-voice-state";

export interface CameraStatusPillProps {
  /** Whose voice is active. See `use-camera-voice-state.ts`. */
  voiceState: CameraVoiceState;
  /**
   * What the session is doing: the catalog copy for
   * `liveVoiceSurfaceLabelKey` in `live-voice-store.ts` (which is where mute
   * already becomes "Muted" and a silent mid-turn `speaking` already becomes
   * "Thinking…"). Handed down translated rather than derived here so this
   * pill, the room's caption, and the iOS Live Activity cannot drift apart.
   * Empty for the phases that carry no label, which drops the word rather than
   * inventing one.
   */
  statusLabel: string;
  /** The session assistant's name, spoken when it is the one talking. */
  assistantName?: string | null;
}

export function CameraStatusPill({
  voiceState,
  statusLabel,
  assistantName,
}: CameraStatusPillProps) {
  const { t } = useTranslation("chat");
  const reduce = useReducedMotion();

  const name = assistantName?.trim() || t("cameraStatusPill.yourAssistant");
  const speaking = voiceState === "assistant";
  const voiceWord = speaking ? name : statusLabel;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="camera-status-pill"
      style={cameraModeStyle()}
      className={cn(
        // A floor width, so the word swapping between the session's phases and
        // the assistant's name does not shuffle a centred pill sideways on
        // every turn of the conversation. The ceiling is the room's, since only
        // it knows what corner chrome the pill has to keep clear of.
        "inline-flex min-w-[9rem] max-w-full items-center justify-center",
        "rounded-full",
        "border-[0.5px] border-[rgba(255,255,255,0.18)] bg-[rgba(0,0,0,0.34)]",
        // Blur rather than a heavier fill: the frame behind can be any
        // brightness, and an opaque chip over a viewfinder reads as a hole.
        "px-3 py-[5px] backdrop-blur-[8px]",
        "text-label-medium-default text-[rgba(255,255,255,0.88)]",
        // The token's 11px at the design's 600. Rebinding the weight var beats
        // a `font-semibold` beside it: both set `font-weight`, and which one
        // wins is Tailwind's utility ordering rather than the order written.
        "[--text-label-medium-default-weight:600]",
      )}
    >
      {/* The visible row is a set of fragments, so it is hidden from assistive
          tech and this sentence is announced in its place. */}
      <span className="sr-only">
        {speaking
          ? t("cameraStatusPill.announcePhotoSpeaking", { name })
          : voiceWord
            ? t("cameraStatusPill.announcePhotoStatus", { status: voiceWord })
            : t("cameraStatusPill.photo")}
      </span>

      <span
        aria-hidden
        className="inline-flex min-w-0 items-center gap-[7px] whitespace-nowrap"
      >
        <span
          data-testid="camera-status-dot"
          className={cn(
            "size-[5px] flex-none rounded-full",
            voiceState === "idle" && "bg-white/50",
            voiceState === "user" && "bg-white",
            voiceState === "assistant" && "bg-[var(--camera-accent-soft)]",
            // The blink is the "a voice is live right now" signal. Held static
            // under reduced motion here as well as in the keyframe's own media
            // block, matching the `voice-caret-blink` convention.
            voiceState !== "idle" && !reduce && "camera-status-blink",
          )}
        />
        <span className="flex-none">{t("cameraStatusPill.photo")}</span>
        {voiceWord ? (
          <>
            <span className="flex-none opacity-45">·</span>
            {/* The only part that gives way: `truncate` clips a long assistant
                name to an ellipsis, and the mode word beside it stays whole. */}
            <span
              data-testid="camera-status-word"
              className="truncate opacity-80"
            >
              {voiceWord}
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}
