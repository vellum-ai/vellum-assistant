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
 * Two modes, told apart by fill as well as by word. Photo is glass, so the
 * frame reads through the mark that is only sampling it; Live is filled with
 * the capture accent, because "this is going out continuously" is the one thing
 * about the surface that has to be legible without reading.
 *
 * It answers no press, so it is a plain region rather than a button, and it
 * announces nothing: a live region that mounts with its first sentence already
 * inside it is announced unreliably, since assistive tech watches an existing
 * region for changes rather than a new one for arrival. The room owns one
 * always-mounted region and fills it from {@link useCameraStatusAnnouncement},
 * which is the same sentence this pill would have spoken.
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

import {
  CAMERA_PILL_GLASS_CLASS,
  CAMERA_PILL_LIVE_CLASS,
  cameraModeStyle,
} from "./camera-mode-paint";
import type { CameraVoiceState } from "./use-camera-voice-state";

/**
 * What the camera is doing: sampling single frames, or streaming. Only `photo`
 * is reachable from the app today; `live` is the mode the design ships the pill
 * for, and the variant exists so the treatment lands with the surface rather
 * than after it.
 */
export type CameraMode = "photo" | "live";

/** The mode's own word, which leads the pill and the announcement alike. */
const MODE_WORD_KEYS = {
  photo: "cameraStatusPill.photo",
  live: "cameraStatusPill.live",
} as const;

/**
 * The whole sentence the room speaks, per mode and per state.
 *
 * Four messages a mode rather than one with a translated fragment pushed into
 * it. "Muted" and the assistant's name belong inside the sentence a translator
 * is writing, so the mute can move where the language puts it and the name can
 * take whatever the verb agrees with. A nested `t()` would fix both at English
 * word order. See `docs/I18N.md`.
 */
const MODE_ANNOUNCE_KEYS = {
  photo: {
    status: "cameraStatusPill.announcePhoto",
    mutedStatus: "cameraStatusPill.announcePhotoMuted",
    speaking: "cameraStatusPill.announcePhotoSpeaking",
    mutedSpeaking: "cameraStatusPill.announcePhotoMutedSpeaking",
  },
  live: {
    status: "cameraStatusPill.announceLive",
    mutedStatus: "cameraStatusPill.announceLiveMuted",
    speaking: "cameraStatusPill.announceLiveSpeaking",
    mutedSpeaking: "cameraStatusPill.announceLiveMutedSpeaking",
  },
} as const;

/** The pill's fill per mode. See `camera-mode-paint.ts` for the values. */
const MODE_CONTAINER_CLASSES = {
  photo: CAMERA_PILL_GLASS_CLASS,
  live: CAMERA_PILL_LIVE_CLASS,
} as const;

export interface CameraStatusPillProps {
  /** What the camera is doing. Defaults to `photo`. */
  mode?: CameraMode;
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

/**
 * Everything the spoken sentence needs, which is the pill's own props plus the
 * mic. Mute is announced and not drawn: the visible row carries whatever word
 * the session's label gives it, so nothing takes a second decision about mute
 * that could drift from that one.
 */
export interface CameraStatusAnnouncement extends CameraStatusPillProps {
  /** Whether the mic is muted. */
  muted?: boolean;
}

/** The name the pill speaks, with a fallback rather than naming nobody. */
function useAssistantWord(assistantName: string | null | undefined): string {
  const { t } = useTranslation("chat");
  return assistantName?.trim() || t("cameraStatusPill.yourAssistant");
}

/**
 * The one sentence camera mode says, for the room's always-mounted live region.
 * `null` while the camera is closed, where the room's own state announcer takes
 * the session back and this returns the empty string rather than unmounting a
 * region assistive tech is watching.
 *
 * One message per state rather than a sentence assembled here: the mode, the
 * mute and the speaker pick the key, and the sentence behind it is whole. What
 * still interpolates is what this sentence does not decide: the session's
 * status word, which the room resolves from this same catalog, or the
 * assistant's name.
 *
 * Saying the mute is what the visible row does not do. The session relabels
 * only `listening` for a muted mic, so "Thinking…" on its own tells a
 * screen-reader user the assistant is working without telling them it cannot
 * hear them. The one phase the session does relabel takes the plain sentence,
 * since the muted one over it reads "Muted. Muted".
 */
export function useCameraStatusAnnouncement(
  status: CameraStatusAnnouncement | null,
): string {
  const { t } = useTranslation("chat");
  const name = useAssistantWord(status?.assistantName);

  if (!status) {
    return "";
  }

  const { mode = "photo", voiceState, statusLabel, muted } = status;
  const keys = MODE_ANNOUNCE_KEYS[mode];

  if (voiceState === "assistant") {
    return t(muted ? keys.mutedSpeaking : keys.speaking, { name });
  }

  const mutedWord = t("liveVoiceStatus.muted");
  const state = statusLabel || (muted ? mutedWord : "");
  if (!state) {
    return t(MODE_WORD_KEYS[mode]);
  }
  return t(muted && state !== mutedWord ? keys.mutedStatus : keys.status, {
    status: state,
  });
}

export function CameraStatusPill({
  mode = "photo",
  voiceState,
  statusLabel,
  assistantName,
}: CameraStatusPillProps) {
  const { t } = useTranslation("chat");
  const reduce = useReducedMotion();

  const name = useAssistantWord(assistantName);
  const speaking = voiceState === "assistant";
  const voiceWord = speaking ? name : statusLabel;

  return (
    <div
      data-testid="camera-status-pill"
      data-camera-mode={mode}
      style={cameraModeStyle()}
      className={cn(
        // A floor width, so the word swapping between the session's phases and
        // the assistant's name does not shuffle a centred pill sideways on
        // every turn of the conversation. The ceiling is the room's, since only
        // it knows what corner chrome the pill has to keep clear of.
        "inline-flex min-w-[9rem] max-w-full items-center justify-center",
        "rounded-full",
        "px-3 py-[5px]",
        "text-label-medium-default",
        // Blur rather than a heavier fill: the frame behind can be any
        // brightness, and an opaque chip over a viewfinder reads as a hole.
        MODE_CONTAINER_CLASSES[mode],
        // The token's 11px at the design's 600. Rebinding the weight var beats
        // a `font-semibold` beside it: both set `font-weight`, and which one
        // wins is Tailwind's utility ordering rather than the order written.
        "[--text-label-medium-default-weight:600]",
      )}
    >
      {/* A set of fragments rather than a sentence, so it is hidden from
          assistive tech; the room's live region speaks the sentence. */}
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
        <span className="flex-none">{t(MODE_WORD_KEYS[mode])}</span>
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
