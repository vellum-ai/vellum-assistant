/**
 * Live transcript for the voice room, rendered into the room's two text zones
 * (see `voice-room-layout.ts`): the user's speech above the eyes, the
 * assistant's below. Two independently pref-gated halves:
 *
 * - USER speech as a soft pill in the upper zone —
 *   `partialTranscript || finalTranscript` from the live-voice store, shown only
 *   when `showUserTranscript` is on. The pill uses the room's bubble tone vars
 *   (white surface / dark text over dark avatars, inverted for the light one).
 *   Set small and quiet: this is a receipt — "did it hear me right?" — not the
 *   thing you're here for.
 * - ASSISTANT speech as untreated text in the lower zone — `assistantTranscript`,
 *   shown only when `showAssistantTranscript` is on AND the assistant isn't idle
 *   behind a new `listening` turn (the transcript lingers until the next
 *   response starts). Set at the room's largest size, with no container at all:
 *   in a voice room this IS the content, so it gets the type presence and the
 *   emphasis rather than the heavier treatment landing on the quieter half.
 *
 * Speaker identity is carried by *zone* alone. At most two items exist at once
 * and they sit either side of the character, so position tells them apart
 * without the alignment-and-bubble conventions a many-message thread needs.
 *
 * Both zones center a column of `VOICE_ROOM_TEXT_MEASURE` and left-align inside
 * it, and each half grows from a fixed edge — the pill rightward from the
 * column's left edge, the assistant text downward — so no arriving word ever
 * shifts a word already on screen. Both prefs default OFF, so by default this
 * renders nothing and the room stays text-free. The zones are
 * `pointer-events-none`, so they never block the room's ✕/gear controls or the
 * mic/stop cluster. Words reveal one at a time via {@link VoiceTranscriptText}.
 * The assistant half's bright leading-edge tone tracks the TTS playhead —
 * {@link useSpokenWordCursor} maps audio progress onto the word list, so the
 * highlight sits on the word being *spoken* rather than the last-arrived one
 * while the streamed text runs ahead of speech. A `null` cursor (the response
 * has produced no audio yet) falls back to the default last-word reveal, so an
 * audio-less response keeps a live leading edge instead of a dead first-word
 * highlight.
 *
 * Subscriptions are deliberately narrow — the three transcript fields, the two
 * prefs, and the low-frequency `state`/`reconnecting` (per-turn, for the
 * listening gate) — so the high-frequency `inputAmplitude` churn on the
 * live-voice store never re-renders this component. The spoken-word cursor
 * keeps that invariant: it polls playback progress outside React, re-renders
 * only when the word index changes, and idles entirely (no frames scheduled)
 * while assistant captions are off. The full transcript still lands in the chat
 * thread on exit via the engine path; this is a live, ambient echo of the
 * current turn only.
 */

import {
  useMemo,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

import { useSpokenWordCursor } from "./use-spoken-word-cursor";
import { toVoiceAvatarVisual } from "./voice-avatar-state";
import {
  VOICE_ROOM_LOWER_ZONE_BOTTOM,
  VOICE_ROOM_LOWER_ZONE_MAX_HEIGHT,
  VOICE_ROOM_TEXT_MEASURE,
  VOICE_ROOM_UPPER_ZONE_HEIGHT,
  VOICE_ROOM_UPPER_ZONE_TOP,
  VOICE_ROOM_ZONE_FADE,
} from "./voice-room-layout";
import {
  splitTranscriptWords,
  VoiceTranscriptText,
} from "./voice-transcript-text";

export function VoiceAmbientTranscript() {
  const showUser = useVoicePrefsStore.use.showUserTranscript();
  const showAssistant = useVoicePrefsStore.use.showAssistantTranscript();

  const partialTranscript = useLiveVoiceStore.use.partialTranscript();
  const finalTranscript = useLiveVoiceStore.use.finalTranscript();
  const assistantTranscript = useLiveVoiceStore.use.assistantTranscript();
  // Low-frequency (per-turn) fields — safe to subscribe to without the
  // `inputAmplitude` churn the narrow subscriptions above avoid.
  const state = useLiveVoiceStore.use.state();
  const reconnecting = useLiveVoiceStore.use.reconnecting();
  const assistantAudioActive = useLiveVoiceStore.use.assistantAudioActive();
  const reduce = useReducedMotion();

  // The same word segmentation `VoiceTranscriptText` renders, so the spoken
  // cursor indexes the exact words on screen.
  const assistantWords = useMemo(
    () => splitTranscriptWords(assistantTranscript),
    [assistantTranscript],
  );
  // A word count of 0 idles the cursor's rAF loop while assistant captions
  // are off, so the hidden caption costs no per-frame work; toggling the pref
  // on mid-response re-syncs on the next frame via the cursor's adoption path.
  const spokenIndex = useSpokenWordCursor(
    showAssistant ? assistantWords.length : 0,
  );

  // In-flight partial wins over the last finalized transcript — same precedence
  // as the underneath composer transcript (`VoiceLiveTranscript`).
  const userText = partialTranscript || finalTranscript;

  // The assistant transcript is only cleared when the NEXT response starts
  // thinking, so a finished response lingers in the store through the following
  // `listening` turn. Hide that half while listening (the assistant isn't
  // speaking then anyway); in thinking/responding it stays.
  const visual = toVoiceAvatarVisual(state, reconnecting, assistantAudioActive);
  const showUserHalf = showUser && userText.length > 0;
  const showAssistantHalf =
    showAssistant && assistantTranscript.length > 0 && visual !== "listening";

  // Each zone enters from its own side of the eyes — the user's from above, the
  // assistant's from below — so the motion states the spatial model rather than
  // just decorating the fade.
  const enter = (from: number) =>
    ({
      initial: reduce ? false : { opacity: 0, y: from },
      animate: { opacity: 1, y: 0 },
      exit: reduce ? { opacity: 0 } : { opacity: 0, y: from },
      transition: { duration: reduce ? 0 : 0.3 },
    }) as const;

  return (
    <AnimatePresence>
      {showUserHalf ? (
        <VoiceRoomTextZone
          key="user"
          placement={{
            top: VOICE_ROOM_UPPER_ZONE_TOP,
            height: VOICE_ROOM_UPPER_ZONE_HEIGHT,
          }}
          {...enter(-10)}
        >
          <div
            data-testid="voice-ambient-user"
            aria-live="polite"
            // The pill grows rightward from the column's left edge, so the
            // words already revealed never shift as the partial extends.
            className="flex justify-start"
          >
            <div
              data-testid="voice-ambient-user-bubble"
              className="max-w-full break-words rounded-2xl px-3.5 py-2 text-[clamp(13px,1.7vmin,16px)] leading-snug"
              style={{ backgroundColor: "var(--room-bubble-bg)" }}
            >
              <VoiceTranscriptText
                text={userText}
                color="var(--room-bubble-fg)"
              />
            </div>
          </div>
        </VoiceRoomTextZone>
      ) : null}

      {showAssistantHalf ? (
        <VoiceRoomTextZone
          key="assistant"
          placement={{
            bottom: VOICE_ROOM_LOWER_ZONE_BOTTOM,
            maxHeight: VOICE_ROOM_LOWER_ZONE_MAX_HEIGHT,
          }}
          {...enter(10)}
        >
          <div
            data-testid="voice-ambient-assistant"
            aria-live="polite"
            className="break-words text-[clamp(17px,2.5vmin,26px)] leading-relaxed"
          >
            <VoiceTranscriptText
              text={assistantTranscript}
              highlightIndex={spokenIndex ?? undefined}
            />
          </div>
        </VoiceRoomTextZone>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * One of the room's two text zones: a full-width band positioned by the caller
 * (`top`/`height` above the eyes, `bottom`/`maxHeight` below), centering the
 * shared text measure and anchoring its content to the band's bottom edge so
 * overflow rides up into the fade instead of pushing the newest words out.
 */
function VoiceRoomTextZone({
  placement,
  children,
  ...motionProps
}: {
  /** Where the band sits: `top`/`height` above the eyes, `bottom`/`maxHeight` below. */
  placement: CSSProperties;
  children: ReactNode;
} & Pick<
  ComponentProps<typeof motion.div>,
  "initial" | "animate" | "exit" | "transition"
>) {
  return (
    <motion.div
      className="pointer-events-none absolute inset-x-0 z-10 flex flex-col justify-end overflow-hidden px-6"
      style={{
        ...placement,
        maskImage: VOICE_ROOM_ZONE_FADE,
        WebkitMaskImage: VOICE_ROOM_ZONE_FADE,
      }}
      {...motionProps}
    >
      <div
        className="mx-auto w-full"
        style={{ maxWidth: VOICE_ROOM_TEXT_MEASURE }}
      >
        {children}
      </div>
    </motion.div>
  );
}
