/**
 * Live transcript for the voice room, styled as a right-side chat rail. A
 * bottom-anchored column pinned to the room's right edge, newest content at the
 * bottom, with a top fade mask so older lines dissolve as they scroll up. Two
 * independently pref-gated halves:
 *
 * - USER speech as a right-aligned "raised surface" bubble —
 *   `partialTranscript || finalTranscript` from the live-voice store, shown only
 *   when `showUserTranscript` is on. The bubble uses the room's bubble tone vars
 *   (white surface / dark text over dark avatars, inverted for the light one).
 * - ASSISTANT speech as left-aligned muted plain text (no bubble) —
 *   `assistantTranscript`, shown only when `showAssistantTranscript` is on AND
 *   the assistant isn't idle behind a new `listening` turn (the transcript
 *   lingers until the next response starts).
 *
 * Both prefs default OFF, so by default this renders nothing and the room stays
 * text-free. The rail is `pointer-events-none`, so it never blocks the room's
 * ✕/gear controls or the mic/stop cluster. Words reveal one at a time via
 * {@link VoiceTranscriptText}. The assistant half's bright leading-edge tone
 * tracks the TTS playhead — {@link useSpokenWordCursor} maps audio progress
 * onto the word list, so the highlight sits on the word being *spoken* rather
 * than the last-arrived one while the streamed text runs ahead of speech. A
 * `null` cursor (the response has produced no audio yet) falls back to the
 * default last-word reveal, so an audio-less response keeps a live leading
 * edge instead of a dead first-word highlight.
 *
 * Subscriptions are deliberately narrow — the three transcript fields, the two
 * prefs, and the low-frequency `state`/`reconnecting` (per-turn, for the
 * listening gate) — so the high-frequency `inputAmplitude` churn on the
 * live-voice store never re-renders this component. The spoken-word cursor
 * keeps that invariant: it polls playback progress outside React and re-renders
 * only when the word index changes. The full transcript still lands in the chat
 * thread on exit via the engine path; this is a live, ambient echo of the
 * current turn only.
 */

import { useMemo } from "react";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

import { useSpokenWordCursor } from "./use-spoken-word-cursor";
import { toVoiceAvatarVisual } from "./voice-avatar-state";
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
  const spokenIndex = useSpokenWordCursor(assistantWords.length);

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

  // The rail shows whenever either half is present. An empty rail renders no DOM
  // (the text-free room), and presence-managing the container through the outer
  // AnimatePresence below lets the last remaining half fade out instead of
  // popping when it clears.
  const railVisible = showUserHalf || showAssistantHalf;

  const fade = {
    initial: reduce ? false : { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: reduce ? 0 : 0.3 },
  } as const;

  // A top-to-bottom fade so older lines dissolve as newer ones push up from the
  // bottom-anchored column.
  const fadeMask = "linear-gradient(to bottom, transparent, #000 12%)";

  // Absolute children are positioned against the padding box, so the overlay's
  // safe-area padding does not inset this rail — fold the right inset into the
  // rail's own right padding (as the room's corner controls do) so transcript
  // text clears the notch / rounded edge in landscape on notched shells.
  const railRightPad =
    "calc(1.5rem + var(--safe-area-inset-right, env(safe-area-inset-right, 0px)))";

  return (
    <AnimatePresence>
      {railVisible ? (
        <motion.div
          key="rail"
          className="pointer-events-none absolute right-0 top-0 bottom-0 z-10 flex w-[min(30rem,42vw)] flex-col justify-end gap-3 overflow-hidden pl-4 pt-20 pb-28"
          style={{
            paddingRight: railRightPad,
            maskImage: fadeMask,
            WebkitMaskImage: fadeMask,
          }}
          {...fade}
        >
          <AnimatePresence>
            {showUserHalf ? (
              <motion.div
                key="user"
                data-testid="voice-ambient-user"
                aria-live="polite"
                className="flex justify-end"
                {...fade}
              >
                <div
                  data-testid="voice-ambient-user-bubble"
                  className="max-w-[85%] break-words rounded-lg border border-[var(--room-border)] px-4 py-2.5 text-[clamp(15px,2vmin,19px)] leading-snug"
                  style={{ backgroundColor: "var(--room-bubble-bg)" }}
                >
                  <VoiceTranscriptText
                    text={userText}
                    color="var(--room-bubble-fg)"
                  />
                </div>
              </motion.div>
            ) : null}

            {showAssistantHalf ? (
              <motion.div
                key="assistant"
                data-testid="voice-ambient-assistant"
                aria-live="polite"
                className="flex justify-start"
                {...fade}
              >
                <div className="max-w-[95%] break-words text-[clamp(15px,2vmin,19px)] leading-relaxed">
                  <VoiceTranscriptText
                    text={assistantTranscript}
                    highlightIndex={spokenIndex ?? undefined}
                  />
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
