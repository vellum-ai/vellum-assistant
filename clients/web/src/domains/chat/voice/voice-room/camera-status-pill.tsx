/**
 * The readout floating at the top of the room while the camera is open: what
 * the camera is doing, and who is talking, in one mark.
 *
 * One pill rather than two indicators because the two answers are read
 * together. The room's usual state caption is suppressed while the viewfinder
 * is up (it sits in the middle of the frame, where the user is aiming), so
 * without this the only thing on screen saying the session is still listening
 * would be the mic button's absence of red. The dot carries the voice state and
 * the words carry the mode, which is why the mode word leads: it is the one
 * thing the camera chrome does not otherwise say.
 *
 * Photo is the only mode this ships (Live lands with the vision-mode
 * workstream), and the pill is not interactive yet, so it is a status region
 * rather than a button.
 *
 * Presentational: the room derives the voice state and owns the assistant
 * identity, so nothing here reaches for a store and the whole state matrix is
 * reachable from props.
 */

import { cn } from "@vellumai/design-library";
import { useReducedMotion } from "motion/react";

import { useTranslation } from "@/i18n";
import { assistantDisplayName } from "@/utils/assistant-display-name";

import { cameraModeStyle } from "./camera-mode-paint";
import type { CameraVoiceState } from "./use-camera-voice-state";

export interface CameraStatusPillProps {
  /** Whose voice is active. See `use-camera-voice-state.ts`. */
  voiceState: CameraVoiceState;
  /** The mic is off, which the voice word has to say however the dot reads. */
  muted?: boolean;
  /** The session assistant's name, spoken when it is the one talking. */
  assistantName?: string | null;
}

export function CameraStatusPill({
  voiceState,
  muted = false,
  assistantName,
}: CameraStatusPillProps) {
  const { t } = useTranslation("chat");
  const reduce = useReducedMotion();

  const name = assistantDisplayName(assistantName);
  const speaking = voiceState === "assistant";
  // Muted only reaches the word. The dot answers "is a voice active", which a
  // muted mic does not change for the assistant's half of the conversation.
  const voiceWord = speaking
    ? name
    : t(muted ? "cameraStatusPill.muted" : "cameraStatusPill.listening");

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="camera-status-pill"
      style={cameraModeStyle()}
      className={cn(
        // A floor width, so the word swapping between "Listening", "Muted" and
        // the assistant's name does not shuffle a centred pill sideways on
        // every turn of the conversation.
        "inline-flex min-w-[9rem] items-center justify-center rounded-full",
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
          : t(
              muted
                ? "cameraStatusPill.announcePhotoMuted"
                : "cameraStatusPill.announcePhotoListening",
            )}
      </span>

      <span
        aria-hidden
        className="inline-flex items-center gap-[7px] whitespace-nowrap"
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
        <span>{t("cameraStatusPill.photo")}</span>
        <span className="opacity-45">·</span>
        <span className="opacity-80">{voiceWord}</span>
      </span>
    </div>
  );
}
